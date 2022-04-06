import fs from "fs";
import ejs from "#core/ejs";
import dns from "dns";
import fetch from "#core/fetch";
import { resolve } from "#core/utils";

export default class NginxService {
    #nginx;
    #id;
    #name;
    #serverName = new Set();
    #streamPort;
    #options;
    #isRemoved;
    #isUpdating;
    #nginxReloadListener;
    #upstreamUpdateInterval;
    #peers = new Set();
    #isHttpEnabled = false;
    #isStreamEnabled = false;

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

    get serverName () {
        return this.#serverName;
    }

    get streamPort () {
        return this.#streamPort;
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
    // XXX
    update ( labels ) {
        let updated;

        // compare labels
        for ( const label in this.#options ) {
            if ( this.#options[label] !== labels[label] ) {
                updated = true;

                console.log( `Service: ${this.name}, label: ${label}=${labels[label]}` );
            }
        }

        const removeHttpVhost = this.#options["nginx.server-name"] && !labels["nginx.server-name"],
            removeStreamVhost = this.#options["nginx.stream-port"] && !labels["nginx.stream-port"];

        this.#options = labels;

        // remove vhosts
        if ( removeHttpVhost || removeStreamVhost ) return this.remove( { "http": removeHttpVhost, "stream": removeStreamVhost } );

        // load balancer labels were removed
        if ( !this.#options["nginx.server-name"] && !this.#options["nginx.stream-port"] ) return;

        // labels wasn't changed
        if ( !updated ) return;

        // generate http vhost conf
        if ( this.#options["nginx.server-name"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.http.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "use_ipv6": this.nginx.useIpV6,
                "upstream_server": "tasks." + this.name,

                "server_name": this.#options["nginx.server-name"].split( /,\s*/ ).join( " " ),
                "client_max_body_size": this.#options["nginx.client-max-body-size"],
                "cache_dir": this.#nginx.cacheDir,
                "cache": this.#options["nginx.cache"] === "true",
                "cache_max_size": this.#options["nginx.cache.max-size"],
                "cache_inactive": this.#options["nginx.cache.inactive"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostHttpPath, conf );
        }

        // generate stream vhost conf
        if ( this.#options["nginx.stream-port"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.stream.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "use_ipv6": this.nginx.useIpV6,
                "upstream_server": "tasks." + this.name,

                "stream_port": this.#options["nginx.stream-port"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostStreamPath, conf );
        }

        // reload nginx
        this.#nginx.reload();
    }

    // XXX update only if required
    async updateUpstreams () {
        if ( this.#nginx.isReloading ) return;

        if ( this.#isUpdating ) return;

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

        if ( !this.#isHttpEnabled && !this.#isStreamEnabled ) return;

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
            const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&add=&server=${peer}:${this.#options["nginx.stream-port"]}&stream=` );

            if ( res.ok ) {
                console.log( `Service: ${this.name}, stream peer added: ${peer}:${this.#options["nginx.stream-port"]}` );

                this.#peers.add( peer );
            }
            else {
                console.log( `Service: ${this.name}, failed to add stream peer: ${peer}:${this.#options["nginx.stream-port"]}` );
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
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&remove=&server=${peer}:${this.#options["nginx.stream-port"]}&stream=` );

            console.log( `Service: ${this.name}, stream peer removed: ${peer}:${this.#options["nginx.stream-port"]}` );
        }

        this.#peers.delete( peer );
    }
}
