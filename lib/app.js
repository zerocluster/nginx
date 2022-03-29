import App from "#core/app";
import config from "#lib/app.config";
import fs from "fs";
import childProcess from "child_process";
import ejs from "#core/ejs";
import dns from "dns";
import DockerEngine from "#core/api/docker/engine";
import fetch from "#core/fetch";
import Events from "events";
import { resolve } from "#core/utils";

const BASE_DIR = process.platform === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

const NGINX_STARTUP_DELAY = 3000;
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

const LABELS = {

    // http
    "nginx.server-name": null,
    "nginx.client-max-body-size": "10m",
    "nginx.cache": "true",
    "nginx.cache.max-size": "10g",
    "nginx.cache.inactive": "1w",

    // stream
    "nginx.stream-port": null,
};

const SERVICES = [];

const DOCKER_ENGINE = new DockerEngine();

class Service {
    #nginx;
    #id;
    #name;
    #labels;
    #peers = new Set();
    #updating;
    #listeners = {};

    constructor ( nginx, id, options = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = options.name;
        this.#labels = { ...LABELS, ...( options.labels || {} ) };
    }

    // static
    static async new ( nginx, id, options = {} ) {
        if ( id instanceof Service ) return id;

        const service = new Service( nginx, id, options );

        if ( !service.name ) await service.init();

        return service;
    }

    // properties
    get nginx () {
        return this.#nginx;
    }

    get id () {
        return this.#id;
    }

    get name () {
        return this.#name;
    }

    get labels () {
        return this.#labels;
    }

    get vhostHttpPath () {
        return VHOSTS_DIR + "/" + this.id + ".http.nginx.conf";
    }

    get vhostStreamPath () {
        return VHOSTS_DIR + "/" + this.id + ".stream.nginx.conf";
    }

    get vhostCachePath () {
        return CACHE_DIR + "/" + this.id;
    }

    // public
    async init () {
        const service = await DOCKER_ENGINE.inspectService( this.id );

        this.#name = service.data.Spec.Name;
        this.#labels = service.data.Spec.Labels;
    }

    update ( labels ) {

        // new service
        if ( !SERVICES[this.id] ) {

            // unable to register service
            if ( !this.#labels["nginx.server-name"] && !this.#labels["nginx.stream-port"] ) return;

            // add service
            SERVICES[this.id] = this;

            // listen for "reload" event
            this.#nginx.on( "reload", ( this.#listeners.reload = this.#reload.bind( this ) ) );

            this.#nginx.setMaxListeners( this.#nginx.getMaxListeners() + 1 );

            console.log( `Service: ${this.name}, added` );
        }

        // compare labels
        if ( labels ) {
            labels = { ...LABELS, ...labels };

            let updated;

            for ( const label in LABELS ) {
                if ( this.#labels[label] !== labels[label] ) {
                    updated = true;

                    console.log( `Service: ${this.name}, label: ${label}=${labels[label]}` );
                }
            }

            this.#labels = labels;

            // "nginx.server-name" or "nginx.stream-port" was removed - remove service
            if ( !this.#labels["nginx.server-name"] && !this.#labels["nginx.stream-port"] ) return this.remove();

            // nothing to update
            if ( !updated ) return;
        }

        // generate http vhost conf
        if ( this.#labels["nginx.server-name"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.http.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "ipv6": this.nginx.ipV6,
                "upstream_server": "tasks." + this.name,

                "server_name": ( this.#labels["nginx.server-name"] || "" ).split( /,\s*/ ).join( " " ),
                "client_max_body_size": this.#labels["nginx.client-max-body-size"],
                "cache_dir": CACHE_DIR,
                "cache": this.#labels["nginx.cache"] === "true",
                "cache_max_size": this.#labels["nginx.cache.max-size"],
                "cache_inactive": this.#labels["nginx.cache.inactive"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostHttpPath, conf );
        }

        // generate stream vhost conf
        if ( this.#labels["nginx.stream-port"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.stream.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "ipv6": this.nginx.ipV6,
                "upstream_server": "tasks." + this.name,

                "stream_port": this.#labels["nginx.stream-port"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostStreamPath, conf );
        }

        // reload nginx
        this.#nginx.reload();
    }

    async updateUpstreams () {
        if ( this.#nginx.reloading ) return;

        if ( this.#updating ) return;

        this.#updating = true;

        const newPeers = await this.#resolvePeers();

        // check added peers
        for ( const peer of newPeers ) if ( !this.#peers.has( peer ) ) await this.#addPeer( peer );

        // check removed peers
        for ( const peer of this.#peers ) if ( !newPeers.has( peer ) ) await this.#removePeer( peer );

        this.#updating = false;
    }

    remove () {

        // nothing to remove
        if ( !SERVICES[this.id] ) return;

        delete SERVICES[this.id];

        this.#nginx.removeListener( "reload", this.#listeners.reload );

        this.#listeners = null;

        // remove vhost
        this.#removeVhost();

        // remove cache
        this.#removeCache();

        console.log( `Service: ${this.name}, removed` );

        // reload nginx
        this.#nginx.reload();
    }

    // private
    #reload () {

        // clear peers
        this.#peers = new Set();

        this.updateUpstreams();
    }

    #removeVhost () {
        var removed = false;

        if ( fs.existsSync( this.vhostHttpPath ) ) {
            fs.rmSync( this.vhostHttpPath, { "force": true } );

            removed = true;
        }

        if ( fs.existsSync( this.vhostStreamPath ) ) {
            fs.rmSync( this.vhostStreamPath, { "force": true } );

            removed = true;
        }

        return removed;
    }

    #removeCache () {
        fs.rmSync( this.vhostCachePath, { "recursive": true, "force": true } );
    }

    async #resolvePeers () {
        try {
            return new Set( await dns.promises.resolve4( "tasks." + this.name ) );
        }
        catch ( e ) {
            return new Set();
        }
    }

    async #addPeer ( peer ) {
        if ( this.#peers.has( peer ) ) return;

        if ( this.#labels["nginx.server-name"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&add=&server=${peer}` );
        }

        if ( this.#labels["nginx.stream-port"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&add=&server=${peer}:${this.#labels["nginx.stream-port"]}` );
        }

        this.#peers.add( peer );

        console.log( `Service: ${this.name}, peer added: ${peer}` );
    }

    async #removePeer ( peer ) {
        if ( !this.#peers.has( peer ) ) return;

        if ( this.#labels["nginx.server-name"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&remove=&server=${peer}` );
        }

        if ( this.#labels["nginx.stream-port"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&remove=&server=${peer}:${this.#labels["nginx.stream-port"]}` );
        }

        this.#peers.delete( peer );

        console.log( `Service: ${this.name}, peer removed: ${peer}` );
    }
}

class Nginx extends Events {
    #ipV6;
    #proc;
    #pendingReload;
    #reloading;
    #started;
    #terminated;

    constructor ( options = {} ) {
        super();

        this.#ipV6 = options.ipV6;
    }

    // properties
    get ipV6 () {
        return this.#ipV6;
    }

    get reloading () {
        return this.#reloading;
    }

    // public
    async run () {

        // remove all vhosts
        if ( fs.existsSync( VHOSTS_DIR ) ) fs.rmSync( VHOSTS_DIR, { "recursive": true, "force": true } );

        // init
        if ( !fs.existsSync( BASE_DIR ) ) fs.mkdirSync( BASE_DIR, { "recursive": true } );
        if ( !fs.existsSync( CACHE_DIR ) ) fs.mkdirSync( CACHE_DIR, { "recursive": true } );
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.mkdirSync( VHOSTS_DIR, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/nginx.conf", import.meta.url ), "utf8" ), {
            "base_dir": BASE_DIR,
            "vhosts_dir": VHOSTS_DIR,
            "ipv6": this.#ipV6,
        } );

        // deploy nginx config
        fs.writeFileSync( CONF_PATH, conf );

        // start swarm listener
        this.#startSwarmListener();

        // get list of services
        const services = await DOCKER_ENGINE.getServices();

        // add services
        for ( let service of services.data ) {
            service = await Service.new( this, service.ID, { "name": service.Spec.Name, "labels": service.Spec.Labels } );

            await service.update();
        }

        // remove stale cache
        fs.readdirSync( CACHE_DIR, { "withFileTypes": true } )
            .filter( entry => entry.isDirectory() )
            .forEach( entry => {
                if ( !SERVICES[entry.name] ) fs.rmSync( CACHE_DIR + "/" + entry.name, { "recursive": true, "force": true } );
            } );

        // test config
        if ( !this.test() ) throw `Nginx configs test failed`;

        // run server
        this.#proc = childProcess.spawn( "nginx", ["-c", CONF_PATH], { "stdio": "inherit", "detached": true } );

        this.#proc.on( "exit", () => process.exit() );

        // setup signal handlers
        process.on( "SIGINT", this.terminate.bind( this ) );
        process.on( "SIGTERM", this.terminate.bind( this ) );
        process.on( "SIGQUIT", this.gracefulShutdown.bind( this ) );
        process.on( "SIGHUP", this.reload.bind( this, false ) );
        process.on( "SIGUSR1", this.reopenLogFiles.bind( this ) );
        process.on( "SIGUSR2", this.upgradeExe.bind( this ) );
        process.on( "SIGWINCH", this.gracefulShutdownWorkers.bind( this ) );

        // start upstream updater
        this.#runUpstreamsUpdater();

        this.#started = true;

        console.log( `Nginx started` );
    }

    test () {
        try {
            childProcess.execFileSync( "nginx", ["-t", "-c", CONF_PATH], { "stdio": "inherit" } );

            return true;
        }
        catch ( e ) {
            return;
        }
    }

    terminate () {
        console.log( "TERM signal received..." );

        this.#terminate();

        this.#proc.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        this.#terminate();

        this.#proc.kill( "SIGQUIT" );
    }

    async reload ( delay ) {
        if ( !this.#started ) return;

        if ( this.#reloading ) {
            this.#pendingReload = true;

            return;
        }

        this.#reloading = true;

        if ( delay ) await new Promise( resolve => setTimeout( resolve, RELOAD_CONFIG_DELAY ) );

        while ( 1 ) {
            this.#pendingReload = false;

            if ( this.test() ) this.#proc.kill( "SIGHUP" );

            // wait for nginx started
            await new Promise( resolve => setTimeout( resolve, NGINX_STARTUP_DELAY ) );

            if ( this.#pendingReload ) continue;

            break;
        }

        this.#reloading = false;

        this.emit( "reload" );
    }

    reopenLogFiles () {
        this.#proc.kill( "SIGUSR1" );
    }

    upgradeExe () {
        this.#proc.kill( "SIGUSR2" );
    }

    gracefulShutdownWorkers () {
        this.#proc.kill( "SIGWINCH" );
    }

    // private
    #terminate () {
        if ( this.#terminated ) return;

        this.#terminated = true;
    }

    async #startSwarmListener () {
        if ( this.#terminated ) return;

        const stream = await DOCKER_ENGINE.monitorSystemEvents( { "filters": { "scope": ["swarm"], "type": ["service"] } } );

        stream.on( "data", async data => {
            const id = data.Actor.ID;

            if ( data.Action === "remove" ) {
                if ( SERVICES[id] ) SERVICES[id].remove();
            }
            else {
                const service = await Service.new( this, id );

                if ( data.Action === "create" ) {

                    // register new service
                    service.update();
                }
                else if ( data.Action === "update" ) {

                    // register new service
                    if ( !SERVICES[id] ) service.update();

                    // update labels of already registered service
                    else SERVICES[id].update( service.labels );
                }
            }
        } );
    }

    async #runUpstreamsUpdater () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            await Promise.all( Object.values( SERVICES ).map( service => service.updateUpstreams() ) );
        }
    }
}

export default class extends App {
    constructor () {
        super( import.meta.url, config );
    }

    // static
    static cli () {
        return {
            "options": {},
            "arguments": {},
        };
    }

    // public
    async run () {
        const res = await super.run();

        if ( !res.ok ) return res;

        this.nginx = new Nginx();

        await this.nginx.run();

        return res;
    }
}
