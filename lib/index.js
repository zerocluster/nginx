const os = require( "os" );
const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );
const dns = require( "dns" );
const fetch = require( "node-fetch" );
const Docker = require( "dockerode" );

const BASE_DIR = os.platform() === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;
const SERVER_NAME_LABEL = process.env.SERVER_NAME_LABEL;

var docker = new Docker( { "socketPath": "/var/run/docker.sock" } );

class Service {
    #id;
    #name;
    #serverName;
    #peers;

    static new ( id, options = {} ) {
        if ( id instanceof Service ) return id;

        return new Service( id, options );
    }

    constructor ( id, options = {} ) {
        this.#id = id;
        this.#name = options.name;
        this.#serverName = options.serverName;
    }

    get id () {
        return this.#id;
    }

    async getName () {
        if ( !this.#name ) await this.#inspect();

        return this.#name;
    }

    async getServerName () {
        if ( !this.#serverName ) await this.#inspect();

        return this.#serverName;
    }

    async getPeers () {
        if ( !this.#peers ) this.#peers = await this.resolvePeers();

        return this.#peers;
    }

    async resolvePeers () {
        try {
            return new Set( await dns.promises.resolve4( "tasks." + ( await this.getName() ) ) );
        }
        catch ( e ) {
            return new Set();
        }
    }

    async #inspect () {
        const service = await docker.getService( this.id ).inspect();

        this.#name = service.Spec.Name;
        this.#serverName = service.Spec.Labels[SERVER_NAME_LABEL];
    }
}

module.exports = class Nginx {
    #ipV6;
    #proc;
    #services = {};
    #pendingReload;
    #reloading;
    #terminated;

    constructor ( options = {} ) {
        this.#ipV6 = options.ipV6;
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

        // init vhosts
        const services = await docker.listServices();

        for ( const service of services ) {
            await this.#addService( new Service( service.ID, { "name": service.Spec.Name, "serverName": service.Spec.Labels[SERVER_NAME_LABEL] } ) );
        }

        // remove stale cache
        fs.readdirSync( CACHE_DIR, { "withFileTypes": true } )
            .filter( entry => entry.isDirectory() )
            .forEach( entry => {
                if ( !this.#services[entry.name] ) fs.rmSync( CACHE_DIR + "/" + entry.name, { "recursive": true, "force": true } );
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
        process.on( "SIGHUP", this.reloadConfig.bind( this, false ) );
        process.on( "SIGUSR1", this.reopenLogFiles.bind( this ) );
        process.on( "SIGUSR2", this.upgradeExe.bind( this ) );
        process.on( "SIGWINCH", this.gracefulShutdownWorkers.bind( this ) );

        // start upstream updater
        await this.#updateUpstreams();

        console.log( `nginx started` );
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

    async reloadConfig ( delay ) {
        if ( this.#reloading ) {
            this.#pendingReload = true;

            return;
        }

        this.#reloading = true;
        this.#pendingReload = false;

        if ( delay ) await new Promise( resolve => setTimeout( resolve, RELOAD_CONFIG_DELAY ) );

        if ( this.test() ) this.#proc.kill( "SIGHUP" );

        this.#reloading = false;

        if ( this.#pendingReload ) this.reloadConfig( delay );
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

        docker.getEvents( { "filters": JSON.stringify( { "scope": ["swarm"], "type": ["service"] } ) }, ( err, stream ) => {
            docker.modem.followProgress( stream,
                () => this.#startSwarmListener(),
                async data => {
                    let restart;

                    const service = new Service( data.Actor.ID );

                    if ( data.Action === "create" ) restart = await this.#addService( service );
                    else if ( data.Action === "remove" ) restart = await this.#removeService( service );
                    else if ( data.Action === "update" ) restart = await this.#updateService( service );

                    if ( restart ) this.reloadConfig( true );
                } );
        } );
    }

    async #updateService ( service ) {

        // service has no label
        if ( !( await service.getServerName() ) ) {
            return this.#removeService( service );
        }

        // service alreay exists
        else if ( this.#services[service.id] ) {

            // label was updated
            if ( ( await this.#services[service.id].getServerName() ) !== ( await service.getServerName() ) ) {
                this.#removeService( service );

                return this.#addService( service );
            }
        }

        // new service
        else {
            return this.#addService( service );
        }
    }

    #removeService ( service ) {
        if ( !this.#services[service.id] ) return;

        fs.rmSync( VHOSTS_DIR + "/" + service.id + ".nginx.conf", { "force": true } );
        fs.rmSync( CACHE_DIR + "/" + service.id, { "recursive": true, "force": true } );

        delete this.#services[service.id];

        return true;
    }

    async #addService ( service ) {
        if ( !( await service.getServerName() ) ) return this.#removeService( service );

        this.#services[service.id] = service;

        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            "id": service.id,
            "ipv6": this.#ipV6,
            "upstream_server": "tasks." + ( await service.getName() ),
            "server_name": await service.getServerName(),
            "cache_dir": CACHE_DIR,
            "peers": await service.getPeers(),
        } );

        fs.writeFileSync( VHOSTS_DIR + "/" + service.id + ".nginx.conf", conf );

        return true;
    }

    async #updateUpstreams () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            for ( const service of Object.values( this.#services ) ) {
                const peers = await service.resolvePeers();
                const servicePeers = await service.getPeers();

                for ( const peer of peers ) if ( !servicePeers.has( peer ) ) await this.#addPeer( service, peer );

                for ( const peer of servicePeers ) if ( !peers.has( peer ) ) await this.#removePeer( service, peer );
            }
        }
    }

    async #addPeer ( service, peer ) {
        ( await service.getPeers() ).add( peer );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + service.id + "&add=&server=" + peer );
    }

    async #removePeer ( service, peer ) {
        ( await service.getPeers() ).delete( peer );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + service.id + "&remove=&server=" + peer );
    }
};
