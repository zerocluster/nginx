import fs from "fs";
import ejs from "#core/ejs";
import dns from "dns";
import fetch from "#core/fetch";
import { resolve } from "#core/utils";

const DEFAULT_OPTIONS = {

    // http
    "httpServerName": null,
    "httpMaxBodySize": "10m",
    "httpCacheEnabled": true,
    "httpCacheMaxSize": "10g",
    "httpCacheInactive": "1w",

    // stream
    "streamPort": null,
};

export default class NginxService {
    #nginx;
    #id;
    #name;
    #httpServerName = new Set();
    #streamPort;
    #isHttpEnabled = false;
    #isStreamEnabled = false;
    #options;
    #isRemoved;
    #isUpdating;
    #nginxReloadListener;
    #upstreamUpdateInterval;
    #peers = new Set();

    constructor ( nginx, id, name ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = name;
        this.#nginxReloadListener = this.#onNginxReload.bind( this );

        // listen for "reload" event
        this.#nginx.setMaxListeners( this.#nginx.getMaxListeners() + 1 );
        this.#nginx.on( "reload", this.#nginxReloadListener );
    }

    // properties
    get id () {
        return this.#id;
    }

    get name () {
        return this.#name;
    }

    get isRemoved () {
        return this.#isRemoved;
    }

    get httpServerName () {
        return this.#httpServerName;
    }

    get streamPort () {
        return this.#streamPort;
    }

    get isEnabled () {
        return this.#isHttpEnabled || this.#isStreamEnabled;
    }

    get vhostHttpPath () {
        return this.#nginx.vhostsDir + "/" + this.id + ".http.nginx.conf";
    }

    get vhostStreamPath () {
        return this.#nginx.vhostsDir + "/" + this.id + ".stream.nginx.conf";
    }

    get vhostCachePath () {
        return this.#nginx.cacheDir + "/" + this.id;
    }

    // public
    update ( options = {} ) {
        if ( this.#isRemoved ) return;

        var updated;

        // init
        if ( !this.#options ) {
            this.#options = {};

            options = { ...DEFAULT_OPTIONS, ...options };
        }

        // update
        else {
            options = { ...this.#options, ...options };
        }

        // validate and coerce options
        if ( !Array.isArray( options.httpServerName ) ) options.httpServerName = [];
        if ( !this.#nginx.validateSizeValue( options.httpMaxBodySize ) ) options.httpMaxBodySize = DEFAULT_OPTIONS.httpMaxBodySize;
        options.httpCacheEnabled = !!options.httpCacheEnabled;
        if ( !this.#nginx.validateSizeValue( options.httpCacheMaxSize ) ) options.httpCacheMaxSize = DEFAULT_OPTIONS.httpCacheMaxSize;
        if ( !this.#nginx.validateTimeValue( options.httpCacheInactive ) ) options.httpCacheInactive = DEFAULT_OPTIONS.httpCacheInactive;

        options.streamPort = parseInt( options.streamPort );
        if ( isNaN( options.streamPort ) || options.streamPort <= 0 || options.streamPort > 65535 ) options.streamPort = null;

        // compare options
        for ( const option in options ) {
            if ( option === "httpServerName" ) {
                if ( options.httpServerName.length !== this.#httpServerName.size ) {
                    updated = true;

                    break;
                }

                for ( const name of options.httpServerName ) {
                    if ( !this.#httpServerName.has( name ) ) {
                        updated = true;

                        break;
                    }
                }
            }
            else if ( this.#options[option] !== options[option] ) {
                updated = true;

                break;
            }
        }

        if ( !updated ) return;

        this.#options = { ...options };

        this.#httpServerName = new Set( options.httpServerName.sort() );
        this.#isHttpEnabled = !!this.#httpServerName.size;

        this.#streamPort = options.streamPort;
        this.#isStreamEnabled = !!this.#streamPort;

        if ( this.#isHttpEnabled ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.http.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "use_ipv6": this.#nginx.useIpV6,
                "upstream_server": "tasks." + this.name,

                "server_name": [...this.#httpServerName].join( " " ),
                "client_max_body_size": this.#options.httpMaxBodySize,
                "cache_dir": this.#nginx.cacheDir,
                "cache": this.#options.httpCacheEnabled,
                "cache_max_size": this.#options.httpCacheMaxSize,
                "cache_inactive": this.#options.httpCacheInactive,
            } );

            // update vhost
            fs.writeFileSync( this.vhostHttpPath, conf );
        }
        else {
            this.#removeHttpVhost();

            // this.#removeHttpCache();
        }

        if ( this.#isStreamEnabled ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.stream.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "use_ipv6": this.#nginx.useIpV6,
                "upstream_server": "tasks." + this.name,

                "stream_port": this.#streamPort,
            } );

            // update vhost
            fs.writeFileSync( this.vhostStreamPath, conf );
        }
        else {
            this.#removeStreamVhost();
        }

        // reload nginx
        this.#nginx.reload();

        // manage upstreams updater
        if ( this.isEnabled ) {
            this.#setUpstreamUpdateInterval();
        }
        else {
            this.#clearUpstreamUpdateInterval();
        }
    }

    async updateUpstreams () {
        if ( this.#nginx.isReloading ) return;

        if ( this.#isUpdating ) return;

        if ( !this.isEnabled ) return;

        this.#isUpdating = true;

        const newPeers = await this.#resolvePeers();

        // check added peers
        for ( const peer of newPeers ) if ( !this.#peers.has( peer ) ) await this.#addPeer( peer );

        // check removed peers
        for ( const peer of this.#peers ) if ( !newPeers.has( peer ) ) await this.#removePeer( peer );

        this.#isUpdating = false;
    }

    remove () {
        if ( this.#isRemoved ) return;

        this.#isRemoved = true;

        this.#clearUpstreamUpdateInterval();

        this.#nginx.removeListener( "reload", this.#nginxReloadListener );
        this.#nginxReloadListener = null;

        var reload;

        if ( this.#removeHttpVhost() ) reload = true;

        if ( this.#removeStreamVhost() ) reload = true;

        this.#removeHttpCache();

        // reload nginx
        if ( reload ) this.#nginx.reload();
    }

    // private
    #setUpstreamUpdateInterval () {
        if ( this.#upstreamUpdateInterval ) return;

        if ( !this.#nginx.upstreamUpdateInterval ) return;

        this.#upstreamUpdateInterval = setInterval( this.updateUpstreams.bind( this ), this.#nginx.upstreamUpdateInterval );
    }

    #clearUpstreamUpdateInterval () {
        if ( !this.#upstreamUpdateInterval ) return;

        clearInterval( this.#upstreamUpdateInterval );

        this.#upstreamUpdateInterval = null;
    }

    #onNginxReload () {

        // clear peers
        this.#peers = new Set();

        this.updateUpstreams();
    }

    #removeHttpVhost () {
        var removed = false;

        if ( fs.existsSync( this.vhostHttpPath ) ) {
            fs.rmSync( this.vhostHttpPath, { "force": true } );

            removed = true;
        }

        return removed;
    }

    #removeStreamVhost () {
        var removed = false;

        if ( fs.existsSync( this.vhostStreamPath ) ) {
            fs.rmSync( this.vhostStreamPath, { "force": true } );

            removed = true;
        }

        return removed;
    }

    #removeHttpCache () {
        var removed = false;

        if ( fs.existsSync( this.vhostCachePath ) ) {
            fs.rmSync( this.vhostCachePath, { "recursive": true, "force": true } );

            removed = true;
        }

        return removed;
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

        // peer already added
        if ( this.#peers.has( peer ) ) return;

        if ( this.#isHttpEnabled ) {
            const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&add=&server=${peer}` );

            if ( res.ok ) {
                console.log( `Service: ${this.name}, http peer added: ${peer}:80` );

                this.#peers.add( peer );
            }
            else {
                console.log( `Service: ${this.name}, failed to add http peer: ${peer}:80` );
            }
        }

        if ( this.#isStreamEnabled ) {
            const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&add=&server=${peer}:${this.#streamPort}&stream=` );

            if ( res.ok ) {
                console.log( `Service: ${this.name}, stream peer added: ${peer}:${this.#streamPort}` );

                this.#peers.add( peer );
            }
            else {
                console.log( `Service: ${this.name}, failed to add stream peer: ${peer}:${this.#streamPort}` );
            }
        }
    }

    async #removePeer ( peer ) {

        // peer is not added
        if ( !this.#peers.has( peer ) ) return;

        if ( this.#isHttpEnabled ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&remove=&server=${peer}` );

            console.log( `Service: ${this.name}, http peer removed: ${peer}:80` );
        }

        if ( this.#isStreamEnabled ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&remove=&server=${peer}:${this.#streamPort}&stream=` );

            console.log( `Service: ${this.name}, stream peer removed: ${peer}:${this.#streamPort}` );
        }

        this.#peers.delete( peer );
    }
}
