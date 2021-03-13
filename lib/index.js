const os = require( "os" );
const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );
const dns = require( "dns" );
const Docker = require( "dockerode" );
const fetch = require( "node-fetch" );
const Events = require( "events" );

const BASE_DIR = os.platform() === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

const NGINX_STARTUP_DELAY = 3000;
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

const LABELS = {
    "nginx.server-name": null,
    "nginx.client-max-body-size": "10m",
    "nginx.cache": "true",
    "nginx.cache.max-size": "10g",
    "nginx.cache.inactive": "1w",
};

const SERVICES = [];

const DOCKER = new Docker( { "socketPath": "/var/run/docker.sock" } );

class Service {
    #nginx;
    #id;
    #name;
    #labels;
    #peers = new Set();
    #updating;
    #listeners = {};

    static async new ( nginx, id, options = {} ) {
        if ( id instanceof Service ) return id;

        const service = new Service( nginx, id, options );

        if ( !service.name ) await service.$init();

        return service;
    }

    constructor ( nginx, id, options = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = options.name;
        this.#labels = { ...LABELS, ...( options.labels || {} ) };
    }

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

    get vhostPath () {
        return VHOSTS_DIR + "/" + this.id + ".nginx.conf";
    }

    get vhostCachePath () {
        return CACHE_DIR + "/" + this.id;
    }

    async $init () {
        const service = await DOCKER.getService( this.id ).inspect();

        this.#name = service.Spec.Name;
        this.#labels = service.Spec.Labels;
    }

    update ( labels ) {

        // new service
        if ( !SERVICES[this.id] ) {

            // unable to register service
            if ( !this.#labels["nginx.server-name"] ) return;

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

            // "nginx.server-name" was removed - remove service
            if ( !this.#labels["nginx.server-name"] ) return this.remove();

            // nothing to update
            if ( !updated ) return;
        }

        // generate vhost conf
        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            "id": this.id,
            "cache_dir": CACHE_DIR,
            "ipv6": this.nginx.ipV6,
            "upstream_server": "tasks." + this.name,
            "server_name": this.#labels["nginx.server-name"].split( /,\s*/ ).join( " " ),
            "client_max_body_size": this.#labels["nginx.client-max-body-size"],
            "cache": this.#labels["nginx.cache"] === "true",
            "cache_max_size": this.#labels["nginx.cache.max-size"],
            "cache_inactive": this.#labels["nginx.cache.inactive"],
        } );

        // update vhost
        fs.writeFileSync( this.vhostPath, conf );

        console.log( `Service: ${this.name}, vhost updated` );

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

    #reload () {

        // clear peers
        this.#peers = new Set();

        this.updateUpstreams();
    }

    #removeVhost () {
        if ( fs.existsSync( this.vhostPath ) ) {
            console.log( `Service: ${this.name}, vhost removed` );

            fs.rmSync( this.vhostPath, { "force": true } );

            return true;
        }
        else {
            return false;
        }
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

        try {
            await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + this.id + "&add=&server=" + peer );

            this.#peers.add( peer );

            console.log( `Service: ${this.name}, peer added: ${peer}` );
        }
        catch ( e ) {}
    }

    async #removePeer ( peer ) {
        if ( !this.#peers.has( peer ) ) return;

        try {
            await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + this.id + "&remove=&server=" + peer );

            this.#peers.delete( peer );

            console.log( `Service: ${this.name}, peer removed: ${peer}` );
        }
        catch ( e ) {}
    }
}

module.exports = class Nginx extends Events {
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

    get ipV6 () {
        return this.#ipV6;
    }

    get reloading () {
        return this.#reloading;
    }

    async run () {

        // remove all vhosts
        if ( fs.existsSync( VHOSTS_DIR ) ) fs.rmSync( VHOSTS_DIR, { "recursive": true, "force": true } );

        // init
        if ( !fs.existsSync( BASE_DIR ) ) fs.mkdirSync( BASE_DIR, { "recursive": true } );
        if ( !fs.existsSync( CACHE_DIR ) ) fs.mkdirSync( CACHE_DIR, { "recursive": true } );
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.mkdirSync( VHOSTS_DIR, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/nginx.conf", "utf8" ), {
            "base_dir": BASE_DIR,
            "vhosts_dir": VHOSTS_DIR,
            "ipv6": this.#ipV6,
        } );

        // deploy nginx config
        fs.writeFileSync( CONF_PATH, conf );

        // start swarm listener
        this.#startSwarmListener();

        // get list of services
        const services = await DOCKER.listServices();

        // add services
        for ( let service of services ) {
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
        if ( !this.test() ) return;

        // run server
        this.#proc = child_process.spawn( "nginx", ["-c", CONF_PATH], { "stdio": "inherit", "detached": true } );

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
            child_process.execFileSync( "nginx", ["-t", "-c", CONF_PATH], { "stdio": "inherit" } );

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

    #terminate () {
        if ( this.#terminated ) return;

        this.#terminated = true;
    }

    #startSwarmListener () {
        if ( this.#terminated ) return;

        DOCKER.getEvents( { "filters": JSON.stringify( { "scope": ["swarm"], "type": ["service"] } ) }, ( err, stream ) => {
            DOCKER.modem.followProgress( stream,
                () => this.#startSwarmListener(),
                async data => {
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
        } );
    }

    async #runUpstreamsUpdater () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            await Promise.all( Object.values( SERVICES ).map( service => service.updateUpstreams() ) );
        }
    }
};
