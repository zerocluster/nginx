import fs from "fs";
import childProcess from "child_process";
import ejs from "#core/ejs";
import DockerEngine from "#core/api/docker/engine";
import Events from "events";
import { resolve } from "#core/utils";
import Service from "$lib/service";

const BASE_DIR = process.platform === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

const NGINX_STARTUP_DELAY = 3000;
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

const DOCKER_ENGINE = new DockerEngine();

const SERVICES = [];

export default class Nginx extends Events {
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
