const os = require( "os" );
const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );
const dns = require( "dns" );
const Docker = require( "dockerode" );
const fetch = require( "node-fetch" );

const BASE_DIR = os.platform() === "win32" ? process.env.LOCALAPPDATA + "/nginx" : "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

const UPSTREAMS_UPDATE_INTERVAL = 10000;
const RELOAD_CONFIG_DELAY = 3000;

const LABELS = {
    "nginx.server-name": null,
    "nginx.client-max-body-size": "10m",
};

var docker = new Docker( { "socketPath": "/var/run/docker.sock" } );

class Service {
    #nginx;
    #id;
    #name;
    #labels = { ...LABELS };
    #peers = new Set();

    static async new ( nginx, id, name, options = {} ) {
        if ( id instanceof Service ) return id;

        const service = new Service( nginx, id, options );

        if ( !service.name ) await service.$init();

        return service;
    }

    constructor ( nginx, id, options = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = options.name;
        this.#labels = options.labels;
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
        const service = await docker.getService( this.id ).inspect();

        this.#name = service.Spec.Name;
        this.#labels = service.Spec.Labels;
    }

    async update ( labels ) {

        // compare labels
        if ( labels ) {
            let updated;

            for ( const label in LABELS ) {
                labels[label] ??= LABELS[label];

                if ( this.#labels[label] !== labels[label] ) {
                    updated = true;

                    this.#labels[label] = labels[label];
                }
            }

            console.log( this.#labels );

            if ( !updated ) return;
        }

        console.log( `Vhost for service "${this.name}" updated` );

        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            "id": this.id,
            "ipv6": this.nginx.ipV6,
            "upstream_server": "tasks." + this.name,
            "server_name": this.#labels["nginx.server-name"].split( /,\s*/ ).join( " " ),
            "cache_dir": CACHE_DIR,
            "client_max_body_size": this.#labels["nginx.client-max-body-size"],
        } );

        fs.writeFileSync( this.vhostPath, conf );

        return true;
    }

    async updateUpstreams () {
        const newPeers = await this.#resolvePeers();

        // check added peers
        for ( const peer of newPeers ) if ( !this.#peers.has( peer ) ) await this.#addPeer( peer );

        // check removed peers
        for ( const peer of this.#peers ) if ( !newPeers.has( peer ) ) await this.#removePeer( peer );

        this.#peers = newPeers;
    }

    remove () {

        // remove vhost
        this.#removeVhost();

        // remove cache
        this.#removeCache();

        console.log( `Service removed: ${this.name}` );
    }

    #removeVhost () {
        if ( fs.existsSync( this.vhostPath ) ) {
            console.log( `Vhost for service "${this.name}" removed` );

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
            fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + this.id + "&add=&server=" + peer );

            this.#peers.add( peer );

            console.log( `Service: ${this.name}, peer added: ${peer}` );
        }
        catch ( e ) {}
    }

    async #removePeer ( peer ) {
        if ( !this.#peers.has( peer ) ) return;

        try {
            fetch( "http://127.0.0.1/dynamic-upstream?upstream=" + this.id + "&remove=&server=" + peer );

            this.#peers.delete( peer );

            console.log( `Service: ${this.name}, peer removed: ${peer}` );
        }
        catch ( e ) {}
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

    get ipV6 () {
        return this.#ipV6;
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
            await this.#addService( await Service.new( this, service.ID, { "name": service.Spec.Name, "labels": service.Spec.Labels } ) );
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

        if ( delay ) await new Promise( resolve => setTimeout( resolve, RELOAD_CONFIG_DELAY ) );

        this.#pendingReload = false;

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
                    let reload;

                    if ( data.Action === "remove" ) {
                        reload = await this.#removeService( data.Actor.ID );
                    }
                    else {
                        const service = await Service.new( this, data.Actor.ID );

                        if ( data.Action === "create" ) reload = await this.#addService( service );
                        else if ( data.Action === "update" ) reload = await this.#updateService( service );
                    }

                    if ( reload ) this.reloadConfig( true );
                } );
        } );
    }

    async #updateService ( service ) {

        // service already exists
        if ( this.#services[service.id] ) {

            // nginx server name label was removed
            if ( !service.labels["nginx.server-name"] ) {
                return this.#removeService( service.id );
            }

            // nginx server name label was updated
            else {
                return service.update( service.labels );
            }
        }

        // new service
        else {

            // new service has nginx server name label
            if ( service.labels["nginx.server-name"] ) return this.#addService( service );
        }
    }

    #removeService ( serviceId ) {
        if ( !this.#services[serviceId] ) return;

        this.#services[serviceId].remove();

        delete this.#services[serviceId];

        return true;
    }

    async #addService ( service ) {
        if ( !service.labels["nginx.server-name"] ) return this.#removeService( service.id );

        console.log( `Service added: ${service.name}` );

        this.#services[service.id] = service;

        return service.update();
    }

    async #updateUpstreams () {
        while ( 1 ) {
            for ( const service of Object.values( this.#services ) ) await service.updateUpstreams();

            await new Promise( resolve => setTimeout( resolve, UPSTREAMS_UPDATE_INTERVAL ) );
        }
    }
};
