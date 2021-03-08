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

module.exports = class Nginx {
    #listenV6;
    #docker;
    #proc;
    #vhosts = {};

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
            if ( !service.Spec.Labels["net.softvisio.loadbalancer-server-name"] ) continue;

            await this.#addVhost( service.ID, service.Spec.Name, service.Spec.Labels["net.softvisio.loadbalancer-server-name"] );
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

    // XXX
    #startSwarmListener () {
        this.#docker.getEvents( { "filters": JSON.stringify( { "scope": ["swarm"], "type": ["service"] } ) }, ( err, stream ) => {
            stream.socket.unref();

            this.#docker.modem.followProgress( stream,
                () => {
                    this.#startSwarmListener();
                },
                data => {
                    if ( data.Type === "service" ) {

                        // if (data.Action === "create" || data.Action === "update") this.#refreshServices();
                        // else if (data.Action === "remove") {
                        //     this.#refreshServices();
                        // }
                    }
                } );
        } );
    }

    #removeVhost ( id ) {
        if ( !this.#vhosts[id] ) return;

        fs.unlinkFileSync( VHOSTS_DIR + "/" + id + ".nginx.conf" );

        delete this.#vhosts[id];
    }

    async #addVhost ( id, name, serverName ) {
        this.#vhosts[id] = { id, name, serverName, "peers": await this.#resolvePeers( name ) };

        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            id,
            "listen_v6": this.#listenV6,
            "upstream_server": "tasks." + name,
            "server_name": serverName,
            "cache_dir": CACHE_DIR,
            "peers": this.#vhosts[id].peers,
        } );

        fs.writeFileSync( VHOSTS_DIR + "/" + id + ".nginx.conf", conf );
    }

    async #resolvePeers ( name ) {
        try {
            return new Set( await dns.promises.resolve4( "tasks." + name ) );
        }
        catch ( e ) {
            return new Set();
        }
    }

    // XXX
    async #updateUpstreams () {
        while ( 1 ) {
            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );

            for ( const service of Object.values( this.#vhosts ) ) {
                const peers = await this.#resolvePeers( service.name );

                for ( const peer of peers ) if ( !service.peers.has( peer ) ) await this.#addPeer( service.id, peer );

                for ( const peer of service.peers ) if ( !peers.has( peer ) ) await this.#removePeer( service.id, peer );
            }
        }
    }

    async #addPeer ( id, addr ) {
        this.#vhosts[id].peers.add( addr );

        console.log( "add", addr );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + id + "&add=&server=" + addr );
    }

    async #removePeer ( id, addr ) {
        this.#vhosts[id].peers.delete( addr );

        console.log( "remove", addr );

        return await fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + id + "&remove=&server=" + addr );
    }
};
