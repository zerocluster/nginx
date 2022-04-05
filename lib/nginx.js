import fs from "fs";
import childProcess from "child_process";
import ejs from "#core/ejs";
import DockerEngine from "#core/api/docker/engine";
import Events from "events";
import { resolve } from "#core/utils";
import NginxService from "#lib/service";

const DEFAULT_LOCATION = process.platform === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";

const NGINX_STARTUP_DELAY = 3000;
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

const DOCKER_ENGINE = new DockerEngine();

export default class Nginx extends Events {
    #location;
    #ipV6;
    #proc;
    #configPath;
    #cacheDir;
    #vhostsDir;
    #isStarted;
    #isTerminated;
    #isReloading;
    #pendingReload;
    #services = {};

    constructor ( { location, ipV6 } = {} ) {
        super();

        this.#location = location || DEFAULT_LOCATION;
        this.#ipV6 = ipV6;
    }

    // properties
    get ipV6 () {
        return this.#ipV6;
    }

    get isReloading () {
        return this.#isReloading;
    }

    get configPath () {
        this.#configPath ??= this.#location + "/nginx.conf";

        return this.#configPath;
    }

    get cacheDir () {
        this.#cacheDir ??= this.#location + "/cache";

        return this.#cacheDir;
    }

    get vhostsDir () {
        this.#vhostsDir ??= this.#location + "/vhosts";

        return this.#vhostsDir;
    }

    // public
    async run () {

        // remove all vhosts
        if ( fs.existsSync( this.vhostsDir ) ) fs.rmSync( this.vhostsDir, { "recursive": true, "force": true } );

        // init
        if ( !fs.existsSync( this.#location ) ) fs.mkdirSync( this.#location, { "recursive": true } );
        if ( !fs.existsSync( this.cacheDir ) ) fs.mkdirSync( this.cacheDir, { "recursive": true } );
        if ( !fs.existsSync( this.vhostsDir ) ) fs.mkdirSync( this.vhostsDir, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/nginx.conf", import.meta.url ), "utf8" ), {
            "base_dir": this.#location,
            "vhosts_dir": this.vhostsDir,
            "ipv6": this.#ipV6,
        } );

        // deploy nginx config
        fs.writeFileSync( this.configPath, conf );

        // start swarm listener
        this.#startSwarmListener();

        // get list of services
        const services = await DOCKER_ENGINE.getServices();

        // add services
        for ( let service of services.data ) {
            service = await NginxService.new( this, service.ID, { "name": service.Spec.Name, "labels": service.Spec.Labels } );

            await service.update();
        }

        // remove stale cache
        fs.readdirSync( this.cacheDir, { "withFileTypes": true } )
            .filter( entry => entry.isDirectory() )
            .forEach( entry => {
                if ( !this.#services[entry.name] ) fs.rmSync( this.cacheDir + "/" + entry.name, { "recursive": true, "force": true } );
            } );

        // test config
        if ( !this.test() ) throw `Nginx configs test failed`;

        // run server
        this.#proc = childProcess.spawn( "nginx", ["-c", this.configPath], { "stdio": "inherit", "detached": true } );

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

        this.#isStarted = true;

        console.log( `Nginx started` );
    }

    test () {
        try {
            childProcess.execFileSync( "nginx", ["-t", "-c", this.configPath], { "stdio": "inherit" } );

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
        if ( !this.#isStarted ) return;

        if ( this.#isReloading ) {
            this.#pendingReload = true;

            return;
        }

        this.#isReloading = true;

        if ( delay ) await new Promise( resolve => setTimeout( resolve, RELOAD_CONFIG_DELAY ) );

        while ( 1 ) {
            this.#pendingReload = false;

            if ( this.test() ) this.#proc.kill( "SIGHUP" );

            // wait for nginx started
            await new Promise( resolve => setTimeout( resolve, NGINX_STARTUP_DELAY ) );

            if ( this.#pendingReload ) continue;

            break;
        }

        this.#isReloading = false;

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

    // XXX
    async addService ( id ) {}

    async removeService ( id ) {}

    async updateService ( id ) {}

    // private
    #terminate () {
        if ( this.#isTerminated ) return;

        this.#isTerminated = true;
    }

    async #startSwarmListener () {
        if ( this.#isTerminated ) return;

        const stream = await DOCKER_ENGINE.monitorSystemEvents( { "filters": { "scope": ["swarm"], "type": ["service"] } } );

        stream.on( "data", async data => {
            const id = data.Actor.ID;

            // remove service
            if ( data.Action === "remove" ) {
                if ( this.#services[id] ) this.#services[id].remove();
            }
            else {
                const service = await NginxService.new( this, id );

                // create service
                if ( data.Action === "create" ) {

                    // register new service
                    service.update();
                }

                // update service
                else if ( data.Action === "update" ) {

                    // register new service
                    if ( !this.#services[id] ) service.update();

                    // update labels of already registered service
                    else this.#services[id].update( service.labels );
                }
            }
        } );
    }

    async #runUpstreamsUpdater () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            await Promise.all( Object.values( this.#services ).map( service => service.updateUpstreams() ) );
        }
    }
}
