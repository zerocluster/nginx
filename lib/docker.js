import Events from "#core/events";
import DockerEngine from "#core/api/docker/engine";

const LABELS = {

    // http
    "nginx.server-name": "httpServerName",
    "nginx.client-max-body-size": "httpMaxBodySize",
    "nginx.cache": "httpCacheEnabled",
    "nginx.cache.max-size": "httpCacheMaxSize",
    "nginx.cache.inactive": "httpCacheInactive",

    // stream
    "nginx.stream-port": "streamPort",
};

export default class Docker extends Events {
    #docker = new DockerEngine();
    #isStarted;

    // public
    async getServices () {

        // get list of services
        return ( await this.#docker.getServices() ).data.map( async service => await this.#prepareService( service ) );
    }

    async watch () {
        if ( this.#isStarted ) return;

        this.#isStarted = true;

        const stream = await this.#docker.monitorSystemEvents( { "filters": { "scope": ["swarm"], "type": ["service"] } } );

        stream.on( "data", async data => {

            // remove service
            if ( data.Action === "remove" ) {
                this.emit( "remove", data.Actor.ID );
            }

            // create service
            else if ( data.Action === "create" ) {
                this.emit( "add", await this.#prepareService( data.Actor ) );
            }

            // update service
            else if ( data.Action === "update" ) {
                this.emit( "update", await this.#prepareService( data.Actor ) );
            }
        } );
    }

    // private
    async #prepareService ( service ) {
        if ( !service.Spec ) {
            const spec = await this.#docker.inspectService( service.ID );

            service = spec.data;
        }

        const data = {
            "id": service.ID,
            "name": service.Spec.Name,
            "options": {},
        };

        for ( const [label, value] of Object.entries( service.Spec.Labels ) ) {
            if ( label in LABELS ) data.options[LABELS[label]] = value;
        }

        if ( data.options.httpServerName ) data.options.httpServerName = data.options.httpServerName.split( /,\s*/ );

        return data;
    }
}
