import "#core/shutdown";
import fs from "fs";
import childProcess from "child_process";
import ejs from "#core/ejs";
import Events from "events";
import { sleep, resolve } from "#core/utils";
import NginxService from "#lib/service";
import Docker from "#lib/docker";

const DEFAULT_LOCATION = process.platform === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";

const DEFAULT_LISTEN_IP_FAMILY = 4;

const NGINX_STARTUP_DELAY = 3000;
const NGINX_RELOAD_CONFIG_DELAY = 3000;

export default class Nginx extends Events {
    #shutdownSignal;
    #location;
    #listenIpFamily;
    #proc;
    #docker;
    #configPath;
    #cacheDir;
    #vhostsDir;
    #isStarted = false;
    #isReloading;
    #pendingReload;
    #services = {};

    constructor ( { location, listenIpFamily } = {} ) {
        super();

        this.#location = location || DEFAULT_LOCATION;
        this.#listenIpFamily = listenIpFamily ?? DEFAULT_LISTEN_IP_FAMILY;
        this.#docker = new Docker();
    }

    // properties
    get listenIpFamily () {
        return this.#listenIpFamily;
    }

    get isStarted () {
        return this.#isStarted;
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

    get services () {
        return this.#services;
    }

    // public
    async run () {
        if ( this.#isStarted ) return;

        console.log( `Nginx starting` );

        // remove all vhosts
        if ( fs.existsSync( this.vhostsDir ) ) fs.rmSync( this.vhostsDir, { "recursive": true, "force": true } );

        // init directories structure
        if ( !fs.existsSync( this.#location ) ) fs.mkdirSync( this.#location, { "recursive": true } );
        if ( !fs.existsSync( this.cacheDir ) ) fs.mkdirSync( this.cacheDir, { "recursive": true } );
        if ( !fs.existsSync( this.vhostsDir ) ) fs.mkdirSync( this.vhostsDir, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/nginx.conf", import.meta.url ), "utf8" ), {
            "baseDir": this.#location,
            "vhostsDir": this.vhostsDir,
            "listenIpFamily": this.#listenIpFamily,
        } );

        // deploy nginx config
        fs.writeFileSync( this.configPath, conf );

        // run nginx
        this.#proc = childProcess.spawn( "nginx", ["-c", this.configPath], {
            "detached": true,
            "stdio": "inherit",
        } );

        // shutdown controller
        this.#shutdownSignal = global.shutdown.signal( "nginx process" ).on( "shutdown", gracefule => {
            if ( gracefule ) {
                this.gracefulShutdown();
            }
            else {
                this.shutdown();
            }
        } );

        this.#proc.on( "exit", this.#onProcExit.bind( this ) );

        // setup signal handlers
        process.on( "SIGHUP", this.reload.bind( this, false ) );
        process.on( "SIGUSR1", this.reopenLogFiles.bind( this ) );
        process.on( "SIGUSR2", this.upgradeExecutable.bind( this ) );
        process.on( "SIGWINCH", this.gracefulShutdownWorkers.bind( this ) );

        // wait for nginx started
        await sleep( NGINX_STARTUP_DELAY );

        console.log( `Nginx started` );

        // start swarm listener
        this.#docker
            .on( "add", service => this.addService( service.id, service.name, { "hostname": service.hostname, "options": service.options } ) )
            .on( "remove", service => this.removeService( service.id ) )
            .on( "update", service => this.updateService( service.id, service.options ) );

        await this.#docker.watch();

        // get list of services
        const services = await this.#docker.getServices();

        // add services
        for ( const service of services ) {
            await this.addService( service.id, service.name, { "hostname": service.hostname, "options": service.options } );
        }

        // remove stale cache
        fs.readdirSync( this.cacheDir, { "withFileTypes": true } )
            .filter( entry => entry.isDirectory() )
            .forEach( directory => {
                if ( !this.#services[directory.name] ) fs.rmSync( this.cacheDir + "/" + directory.name, { "recursive": true, "force": true } );
            } );

        this.#isStarted = true;

        this.reload();
    }

    test () {
        console.log( `Nginx testing configuration` );

        try {
            childProcess.execFileSync( "nginx", ["-t", "-c", this.configPath], { "stdio": "inherit" } );

            return true;
        }
        catch ( e ) {
            return;
        }
    }

    shutdown () {
        if ( !this.#isStarted ) return;

        console.log( `Nginx shutdown started` );

        this.#proc?.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        if ( !this.#isStarted ) return;

        console.log( `Nginx graceful shutdown started` );

        this.#proc?.kill( "SIGQUIT" );
    }

    async reload ( delay ) {
        if ( !this.#isStarted ) return;

        if ( this.#isReloading ) {
            this.#pendingReload = true;

            return;
        }

        this.#isReloading = true;

        if ( delay ) await sleep( NGINX_RELOAD_CONFIG_DELAY );

        while ( 1 ) {
            this.#pendingReload = false;

            if ( this.test() ) {
                console.log( `Nginx reloading` );

                this.#proc?.kill( "SIGHUP" );
            }

            // wait for nginx started
            await sleep( NGINX_STARTUP_DELAY );

            if ( !this.#pendingReload ) break;
        }

        this.#isReloading = false;

        this.emit( "reload" );
    }

    reopenLogFiles () {
        if ( !this.#isStarted ) return;

        console.log( `Nginx reopening log files` );

        this.#proc?.kill( "SIGUSR1" );
    }

    upgradeExecutable () {
        if ( !this.#isStarted ) return;

        console.log( `Nginx upgrading executable` );

        this.#proc?.kill( "SIGUSR2" );
    }

    gracefulShutdownWorkers () {
        if ( !this.#isStarted ) return;

        console.log( `Nginx graceful shutdown workers` );

        this.#proc?.kill( "SIGWINCH" );
    }

    async addService ( id, name, { hostname, options } = {} ) {
        this.#services[id] ??= new NginxService( this, id, name, { hostname } );

        return this.updateService( id, options );
    }

    async updateService ( id, options = {} ) {
        const service = this.#services[id];

        if ( !service ) return;

        service.update( options );
    }

    async removeService ( id ) {
        const service = this.#services[id];

        if ( !service ) return;

        delete this.#services[id];

        service.remove();
    }

    // private
    #onProcExit ( code, signal ) {
        this.#proc = null;
        this.#isStarted = false;

        console.log( `Nginx process exited, code: ${code}` );

        process.exitCode = code;

        this.#shutdownSignal.done();

        this.emit( "exit", code );
    }
}
