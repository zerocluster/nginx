import fs from "fs";
import ejs from "#core/ejs";
import dns from "dns";
import DockerEngine from "#core/api/docker/engine";
import fetch from "#core/fetch";
import { resolve } from "#core/utils";

const LABELS = {

    // http
    "nginx.server-name": null,
    "nginx.client-max-body-size": "10m",
    "nginx.cache": "true",
    "nginx.cache.max-size": "10g",
    "nginx.cache.inactive": "1w",

    // stream
    "nginx.stream-port": null,
};

const SERVICES = {};

const DOCKER_ENGINE = new DockerEngine();

export default class NginxService {
    #nginx;
    #id;
    #name;
    #labels;
    #peers = new Set();
    #updating;
    #listeners = {};

    constructor ( nginx, id, { name, labels } = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#name = name;
        this.#labels = { ...LABELS, ...( labels || {} ) };
    }

    // static
    static async new ( nginx, id, { name, labels } = {} ) {
        if ( id instanceof NginxService ) return id;

        const service = new NginxService( nginx, id, { name, labels } );

        if ( !service.name ) await service.init();

        return service;
    }

    // properties
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
    async init () {
        const service = await DOCKER_ENGINE.inspectService( this.id );

        this.#name = service.data.Spec.Name;
        this.#labels = service.data.Spec.Labels;
    }

    update ( labels ) {

        // new service
        if ( !SERVICES[this.id] ) {

            // service has no load balancer settings
            if ( !this.#labels["nginx.server-name"] && !this.#labels["nginx.stream-port"] ) return;

            // add service
            SERVICES[this.id] = this;

            // listen for "reload" event
            this.#nginx.on( "reload", ( this.#listeners.reload = this.#reload.bind( this ) ) );

            this.#nginx.setMaxListeners( this.#nginx.getMaxListeners() + 1 );

            console.log( `Service: ${this.name}, added` );
        }

        // update labels
        else if ( labels ) {

            // merge labels
            labels = { ...LABELS, ...labels };

            let updated;

            // compare labels
            for ( const label in LABELS ) {
                if ( this.#labels[label] !== labels[label] ) {
                    updated = true;

                    console.log( `Service: ${this.name}, label: ${label}=${labels[label]}` );
                }
            }

            const removeHttpVhost = this.#labels["nginx.server-name"] && !labels["nginx.server-name"],
                removeStreamVhost = this.#labels["nginx.stream-port"] && !labels["nginx.stream-port"];

            this.#labels = labels;

            // remove vhosts
            if ( removeHttpVhost || removeStreamVhost ) return this.remove( { "http": removeHttpVhost, "stream": removeStreamVhost } );

            // load balancer labels were removed
            if ( !this.#labels["nginx.server-name"] && !this.#labels["nginx.stream-port"] ) return;

            // labels wasn't changed
            if ( !updated ) return;
        }

        // generate http vhost conf
        if ( this.#labels["nginx.server-name"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.http.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "ipv6": this.nginx.ipV6,
                "upstream_server": "tasks." + this.name,

                "server_name": this.#labels["nginx.server-name"].split( /,\s*/ ).join( " " ),
                "client_max_body_size": this.#labels["nginx.client-max-body-size"],
                "cache_dir": this.#nginx.cacheDir,
                "cache": this.#labels["nginx.cache"] === "true",
                "cache_max_size": this.#labels["nginx.cache.max-size"],
                "cache_inactive": this.#labels["nginx.cache.inactive"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostHttpPath, conf );
        }

        // generate stream vhost conf
        if ( this.#labels["nginx.stream-port"] ) {
            const conf = ejs.render( fs.readFileSync( resolve( "#resources/templates/vhost.stream.nginx.conf", import.meta.url ), "utf8" ), {
                "id": this.id,
                "ipv6": this.nginx.ipV6,
                "upstream_server": "tasks." + this.name,

                "stream_port": this.#labels["nginx.stream-port"],
            } );

            // update vhost
            fs.writeFileSync( this.vhostStreamPath, conf );
        }

        // reload nginx
        this.#nginx.reload();
    }

    async updateUpstreams () {
        if ( this.#nginx.reloading ) return;

        if ( this.#updating ) return;

        this.#updating = true;

        const newPeers = await this.#resolvePeers();

        // check added peers
        for ( const peer of newPeers ) if ( !this.#peers.has( peer ) ) await this.#addPeer( peer );

        // check removed peers
        for ( const peer of this.#peers ) if ( !newPeers.has( peer ) ) await this.#removePeer( peer );

        this.#updating = false;
    }

    remove ( { http = true, stream = true } = {} ) {

        // nothing to remove
        if ( !SERVICES[this.id] ) return;

        // remove completely
        if ( http && stream ) {
            delete SERVICES[this.id];

            this.#nginx.removeListener( "reload", this.#listeners.reload );

            this.#listeners = null;
        }

        var reload = false;

        // http
        if ( http && this.#removeHttpVhost() ) {
            reload = true;

            // remove cache
            this.#removeCache();

            console.log( `Service: ${this.name}, http vhost removed` );
        }

        // stream
        if ( stream && this.#removeStreamVhost() ) {
            reload = true;

            console.log( `Service: ${this.name}, stream vhost removed` );
        }

        // reload nginx
        if ( reload ) this.#nginx.reload();
    }

    // private
    #reload () {

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

        if ( this.#labels["nginx.server-name"] ) {
            const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&add=&server=${peer}` );

            if ( res.ok ) {
                console.log( `Service: ${this.name}, http peer added: ${peer}:80` );

                this.#peers.add( peer );
            }
            else {
                console.log( `Service: ${this.name}, failed to add http peer: ${peer}:80` );
            }
        }

        if ( this.#labels["nginx.stream-port"] ) {
            const res = await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&add=&server=${peer}:${this.#labels["nginx.stream-port"]}&stream=` );

            if ( res.ok ) {
                console.log( `Service: ${this.name}, stream peer added: ${peer}:${this.#labels["nginx.stream-port"]}` );

                this.#peers.add( peer );
            }
            else {
                console.log( `Service: ${this.name}, failed to add stream peer: ${peer}:${this.#labels["nginx.stream-port"]}` );
            }
        }
    }

    async #removePeer ( peer ) {
        if ( !this.#peers.has( peer ) ) return;

        if ( this.#labels["nginx.server-name"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=http-${this.id}&remove=&server=${peer}` );

            console.log( `Service: ${this.name}, http peer removed: ${peer}:80` );
        }

        if ( this.#labels["nginx.stream-port"] ) {
            await fetch( `http://127.0.0.1/dynamic-upstream?upstream=stream-${this.id}&remove=&server=${peer}:${this.#labels["nginx.stream-port"]}&stream=` );

            console.log( `Service: ${this.name}, stream peer removed: ${peer}:${this.#labels["nginx.stream-port"]}` );
        }

        this.#peers.delete( peer );
    }
}
