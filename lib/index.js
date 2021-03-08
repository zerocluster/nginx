const os = require( "os" );
const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );
const dns = require( "dns" );
const fetch = require( "node-fetch" );
const Docker = require( "dockerode" );

const BASE_DIR = os.platform() === "win32" ? process.env.LOCALAPPDATA + "/share/nginx" : "/var/lib/share/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";
const UPSTREAMS_UPDATE_INTERVAL = 10000;
const LOADBALANCER_LABEL = "net.softvisio.loadbalancer-server-name";

module.exports = class Nginx {
    #listenV6;
    #docker;
    #proc;
    #services = {};

    async run () {
        this.#docker = new Docker( { "socketPath": "/var/run/docker.sock" } );

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
            "listen_v6": this.#listenV6,
        } );

        // deploy nginx config
        fs.writeFileSync( CONF_PATH, conf );

        // start swarm listener
        this.#startSwarmListener();

        // init vhosts
        const services = await this.#docker.listServices();

        for ( const service of services ) {
            await this.#addService( service.ID );
        }

        // test config
        if ( !this.test() ) return;

        // run server
        this.#proc = child_process.spawn( "nginx", ["-c", CONF_PATH], { "stdio": "inherit", "detached": true } );

        // setup signal handlers
        process.on( "SIGINT", this.terminate.bind( this ) );
        process.on( "SIGTERM", this.terminate.bind( this ) );
        process.on( "SIGQUIT", this.gracefulShutdown.bind( this ) );
        process.on( "SIGHUP", this.reloadConfig.bind( this ) );
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

        this.#proc.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        this.#proc.kill( "SIGQUIT" );
    }

    reloadConfig () {
        if ( !this.test() ) return;

        this.#proc.kill( "SIGHUP" );
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

    #startSwarmListener () {
        this.#docker.getEvents( { "filters": JSON.stringify( { "scope": ["swarm"], "type": ["service"] } ) }, ( err, stream ) => {
            stream.socket.unref();

            this.#docker.modem.followProgress( stream,
                () => this.#startSwarmListener(),
                async data => {
                    let restart;

                    if ( data.Action === "create" ) restart = await this.#addService( data.Actor.ID );
                    else if ( data.Action === "remove" ) restart = await this.#removeService( data.Actor.ID );
                    else if ( data.Action === "update" ) restart = await this.#updateService( data.Actor.ID );

                    if ( restart ) this.reloadConfig();
                } );
        } );
    }

    async #updateService ( id ) {
        const service = await this.#docker.getService( id ).inspect();

        const serverName = service.Spec.Labels[LOADBALANCER_LABEL];

        // service has no label
        if ( !serverName ) {
            return this.#removeService( id );
        }

        // service alreay exists
        else if ( this.#services[id] ) {

            // label was updated
            if ( this.#services[id].serverName !== serverName ) {
                this.#removeService( id );

                return this.#addService( id );
            }
        }

        // new service
        else {
            return this.#addService( id );
        }
    }

    #removeService ( id ) {
        if ( !this.#services[id] ) return;

        fs.unlinkSync( VHOSTS_DIR + "/" + id + ".nginx.conf" );

        delete this.#services[id];

        return true;
    }

    async #addService ( id ) {
        const service = await this.#docker.getService( id ).inspect();

        const serverName = service.Spec.Labels[LOADBALANCER_LABEL];

        if ( !serverName ) return this.#removeService( id );

        this.#services[id] = { id, "name": service.Spec.Name, serverName, "peers": await this.#resolvePeers( service.Spec.Name ) };

        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            id,
            "listen_v6": this.#listenV6,
            "upstream_server": "tasks." + service.Spec.Name,
            "server_name": serverName,
            "cache_dir": CACHE_DIR,
            "peers": this.#services[id].peers,
        } );

        fs.writeFileSync( VHOSTS_DIR + "/" + id + ".nginx.conf", conf );

        return true;
    }

    async #resolvePeers ( name ) {
        try {
            return new Set( await dns.promises.resolve4( "tasks." + name ) );
        }
        catch ( e ) {
            return new Set();
        }
    }

    async #updateUpstreams () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            for ( const service of Object.values( this.#services ) ) {
                const peers = await this.#resolvePeers( service.name );

                for ( const peer of peers ) if ( !service.peers.has( peer ) ) await this.#addPeer( service.id, peer );

                for ( const peer of service.peers ) if ( !peers.has( peer ) ) await this.#removePeer( service.id, peer );
            }
        }
    }

    async #addPeer ( id, peer ) {
        this.#services[id].peers.add( peer );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + id + "&add=&server=" + peer );
    }

    async #removePeer ( id, peer ) {
        this.#services[id].peers.delete( peer );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + id + "&remove=&server=" + peer );
    }
};
