import fs from "fs";
import ejs from "#core/ejs";
import dns from "dns";
import fetch from "#core/fetch";
import { resolve } from "#core/utils";

const DEFAULT_OPTIONS = {

    // http
    "httpServerName": null,
    "httpClientMaxBodySize": "10m",
    "httpCacheEnabled": true,
    "httpCacheMaxSize": "10g",
    "httpCacheInactive": "1w",

    // stream
    "streamPort": null,
};

export default class NginxService {
    #nginx;
    #id;
    #hostname;
    #name;
    #isHttpEnabled = false;
    #isStreamEnabled = false;
    #options;
    #isRemoved;
    #isUpdating;
    #nginxReloadListener;
    #upstreamUpdateInterval;
    #httpServerName = new Set();
    #streamPort = new Set();
    #peers = new Map();

    constructor ( nginx, id, name, { hostname } = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = name;
        this.#hostname = hostname;
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

    get hostname () {
        return this.#hostname;
    }

    get isRemoved () {
        return this.#isRemoved;
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
        if ( !Array.isArray( options.httpServerName ) ) options.httpServerName = [options.httpServerName];
        options.httpServerName = options.httpServerName.reduce( ( res, name ) => {
            ERROR: if ( typeof name === "string" ) {
                name = name.trim();

                if ( !name ) break ERROR;

                for ( const service of Object.values( this.#nginx.services ) ) {
                    if ( service.id === this.id ) continue;

                    if ( service.hasHttpServiceName( name ) ) {
                        console.log( `Server name "${name}" is already used` );

                        break ERROR;
                    }
                }

                res.push( name );
            }

            return res;
        }, [] );

        if ( !Array.isArray( options.streamPort ) ) options.streamPort = [options.streamPort];
        options.streamPort = options.streamPort.reduce( ( res, port ) => {
            ERROR: if ( port ) {
                port = parseInt( port );
                if ( isNaN( port ) || port <= 0 || port > 65535 ) break ERROR;

                for ( const service of Object.values( this.#nginx.services ) ) {
                    if ( service.id === this.id ) continue;

                    if ( service.hasStreamPort( port ) ) {
                        console.log( `Stream port "${port}" is already used` );

                        break ERROR;
                    }
                }

                res.push( port );
            }

            return res;
        }, [] );

        if ( !this.#nginx.validateNginxSizeValue( options.httpClientMaxBodySize ) ) options.httpClientMaxBodySize = DEFAULT_OPTIONS.httpClientMaxBodySize;
        options.httpCacheEnabled = !!options.httpCacheEnabled;
        if ( !this.#nginx.validateNginxSizeValue( options.httpCacheMaxSize ) ) options.httpCacheMaxSize = DEFAULT_OPTIONS.httpCacheMaxSize;
        if ( !this.#nginx.validateNginxTimeValue( options.httpCacheInactive ) ) options.httpCacheInactive = DEFAULT_OPTIONS.httpCacheInactive;

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
            else if ( option === "streamPort" ) {
                if ( options.streamPort.length !== this.#streamPort.size ) {
                    updated = true;

                    break;
                }

                for ( const port of options.streamPort ) {
                    if ( !this.#streamPort.has( port ) ) {
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

        this.#log( "updated", JSON.stringify( options, null, 4 ) );

        this.#options = { ...options };

        this.#httpServerName = new Set( options.httpServerName.sort() );
        this.#isHttpEnabled = !!this.#httpServerName.size;

        this.#streamPort = new Set( options.streamPort.sort() );
        this.#isStreamEnabled = !!this.#streamPort.size;

        if ( this.#isHttpEnabled ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.http.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "use_ipv6": this.#nginx.useIpV6,
                "upstream_server": this.#hostname,

                "server_name": [...this.#httpServerName].join( " " ),
                "client_max_body_size": this.#options.httpClientMaxBodySize,
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
                "upstream_server": this.#hostname,

                "stream_port": [...this.#streamPort],
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
        if ( !this.isEnabled ) return;
        if ( !this.#hostname ) return;

        if ( this.#isUpdating ) return;

        this.#isUpdating = true;

        const upstreams = await this.#resolveUpstreams();

        const peers = new Map();

        // build list of peers
        for ( const upstream of upstreams ) {
            if ( this.#isHttpEnabled ) {
                peers.set( `${upstream}:80`, { "stream": false, "port": 80 } );
            }

            if ( this.#isStreamEnabled ) {
                for ( const port of this.#streamPort ) {
                    peers.set( `${upstream}:${port}`, { "stream": true, port } );
                }
            }
        }

        // add peers
        for ( const peer of peers.keys() ) if ( !this.#peers.has( peer ) ) await this.#addPeer( peer, peers.get( peer ) );

        // remove peers
        for ( const peer of this.#peers.keys() ) if ( !peers.has( peer ) ) await this.#removePeer( peer, this.#peers.get( peer ) );

        this.#isUpdating = false;
    }

    remove () {
        if ( this.#isRemoved ) return;

        this.#isRemoved = true;

        this.#log( `removed` );

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

    hasHttpServerName ( name ) {
        return this.#httpServerName.has( name );
    }

    hasStreamPort ( port ) {
        return this.#streamPort.has( port );
    }

    // private
    #setUpstreamUpdateInterval () {
        if ( this.#upstreamUpdateInterval ) return;

        if ( !this.#hostname || !this.#nginx.upstreamUpdateInterval ) return;

        this.#upstreamUpdateInterval = setInterval( this.updateUpstreams.bind( this ), this.#nginx.upstreamUpdateInterval );
    }

    #clearUpstreamUpdateInterval () {
        if ( !this.#upstreamUpdateInterval ) return;

        clearInterval( this.#upstreamUpdateInterval );

        this.#upstreamUpdateInterval = null;
    }

    #onNginxReload () {

        // clear upstreams
        this.#peers.clear();

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

    async #resolveUpstreams () {
        try {
            return new Set( await dns.promises.resolve4( this.#hostname ) );
        }
        catch ( e ) {
            return new Set();
        }
    }

    async #addPeer ( peer, { stream, port } ) {
        const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=${this.id}-${port}&add=&server=${peer}${stream ? "&stream=" : ""}` );

        this.#log( `add peer`, peer, res + "" );

        if ( res.ok ) this.#peers.set( peer, { stream, port } );
    }

    async #removePeer ( peer, { stream, port } ) {
        const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=${this.id}-${port}&remove=&server=${peer}${stream ? "&stream=" : ""}` );

        this.#log( `remove peer`, peer, res + "" );

        if ( res.ok ) this.#peers.delete( peer );
    }

    #log ( ...args ) {
        args.unshift( `Service: ${this.name}` );

        console.log( args.join( ", " ) );
    }
}
