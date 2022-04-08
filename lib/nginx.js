import fs from "fs";
import childProcess from "child_process";
import ejs from "#core/ejs";
import Events from "events";
import { sleep, resolve } from "#core/utils";
import NginxService from "#lib/service";
import Docker from "#lib/docker";

const DEFAULT_LOCATION = process.platform === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";

const NGINX_STARTUP_DELAY = 3000;
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

export default class Nginx extends Events {
    #location;
    #useIpV6;
    #upstreamUpdateInterval;
    #proc;
    #docker;
    #configPath;
    #cacheDir;
    #vhostsDir;
    #isStarted = false;
    #isReloading;
    #pendingReload;
    #services = {};

    constructor ( { location, useIpV6, upstreamUpdateInterval } = {} ) {
        super();

        this.#location = location || DEFAULT_LOCATION;
        this.#useIpV6 = useIpV6;
        this.#upstreamUpdateInterval = upstreamUpdateInterval ?? UPSTREAMS_UPDATE_INTERVAL;
        this.#docker = new Docker();
    }

    // properties
    get useIpV6 () {
        return this.#useIpV6;
    }

    get upstreamUpdateInterval () {
        return this.#upstreamUpdateInterval;
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

        this.#isStarted = true;

        // remove all vhosts
        if ( fs.existsSync( this.vhostsDir ) ) fs.rmSync( this.vhostsDir, { "recursive": true, "force": true } );

        // init directories structure
        if ( !fs.existsSync( this.#location ) ) fs.mkdirSync( this.#location, { "recursive": true } );
        if ( !fs.existsSync( this.cacheDir ) ) fs.mkdirSync( this.cacheDir, { "recursive": true } );
        if ( !fs.existsSync( this.vhostsDir ) ) fs.mkdirSync( this.vhostsDir, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/nginx.conf", import.meta.url ), "utf8" ), {
            "base_dir": this.#location,
            "vhosts_dir": this.vhostsDir,
            "use_ipv6": this.#useIpV6,
        } );

        // deploy nginx config
        fs.writeFileSync( this.configPath, conf );

        // start swarm listener
        this.#docker
            .on( "add", data => this.addService( data.id, data.name, data.options ) )
            .on( "remove", id => this.removeService( id ) )
            .on( "update", data => this.updateService( data.id, data.options ) );

        await this.#docker.watch();

        // get list of services
        const services = await this.#docker.getServices();

        // add services
        for ( const service of services ) {
            await this.addService( service.id, service.name, service.options );
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

        this.#proc.on( "exit", this.#onProcExit.bind( this ) );

        // setup signal handlers
        process.on( "SIGINT", this.terminate.bind( this ) );
        process.on( "SIGTERM", this.terminate.bind( this ) );
        process.on( "SIGQUIT", this.gracefulShutdown.bind( this ) );
        process.on( "SIGHUP", this.reload.bind( this, false ) );
        process.on( "SIGUSR1", this.reopenLogFiles.bind( this ) );
        process.on( "SIGUSR2", this.upgradeExecutable.bind( this ) );
        process.on( "SIGWINCH", this.gracefulShutdownWorkers.bind( this ) );

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
        if ( !this.#isStarted ) return;

        console.log( `Terminating` );

        this.#proc?.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        if ( !this.#isStarted ) return;

        console.log( `Graceful shutdown` );

        this.#proc?.kill( "SIGQUIT" );
    }

    async reload ( delay ) {
        if ( !this.#isStarted ) return;

        if ( this.#isReloading ) {
            this.#pendingReload = true;

            return;
        }

        this.#isReloading = true;

        if ( delay ) await sleep( RELOAD_CONFIG_DELAY );

        while ( 1 ) {
            this.#pendingReload = false;

            if ( this.test() ) {
                console.log( `Reloading` );

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

        console.log( `Reopening log files` );

        this.#proc?.kill( "SIGUSR1" );
    }

    upgradeExecutable () {
        if ( !this.#isStarted ) return;

        console.log( `Upgrading executable` );

        this.#proc?.kill( "SIGUSR2" );
    }

    gracefulShutdownWorkers () {
        if ( !this.#isStarted ) return;

        console.log( `Graceful shutdown workers` );

        this.#proc?.kill( "SIGWINCH" );
    }

    async addService ( id, name, options = {} ) {
        this.#services[id] ??= new NginxService( this, id, name );

        return this.updateService( id, options );
    }

    async updateService ( id, options = {} ) {
        const service = this.#services[id];

        if ( !service ) return;

        service.update( options );

        // check options
        if ( options.httpServerName || options.streamPort ) {
            for ( const service of Object.values( this.#services ) ) {
                if ( service.id === id ) continue;

                // check http server name
                if ( options.httpServerName ) {
                    for ( const name of options.httpServerName ) {

                        // server name is already used by the other service
                        if ( service.hasHttpServerName( name ) ) {
                            console.log( `Server name "${name}" is already used` );

                            return;
                        }
                    }
                }

                // check stream port
                if ( options.streamPort ) {

                    // stream port is already used by the other service
                    if ( service.hasStreamPort( options.streamPort ) ) {
                        console.log( `Stream port ${options.streamPort} is already used` );

                        return;
                    }
                }
            }
        }
    }

    async removeService ( id ) {
        const service = this.#services[id];

        if ( !service ) return;

        delete this.#services[id];

        service.remove();
    }

    validateSizeValue ( value ) {
        return /^\d+[kKmMgG]?$/.test( value + "" );
    }

    validateTimeValue ( value ) {
        value = value + "";

        if ( !value ) return false;

        if ( /^\d+$/.test( value ) ) return true;

        if ( /^\d+(?:ms|s|m|h|d|w|M|y)$/.test( value ) ) return true;

        if ( /^(?:\d+y\s*)?(?:\d+M\s*)?(?:\d+w\s*)?(?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s\s*)?(?:\d+ms\s*)?$/.test( value ) ) return true;

        return false;
    }

    // private
    #onProcExit () {
        this.#proc = null;
        this.#isStarted = false;

        this.emit( "exit" );
    }
}
