import App from "#core/app";
import Nginx from "#lib/nginx";

export default class extends App {
    #nginx;

    // propeties
    get location () {
        return import.meta.url;
    }

    // protected
    async _init () {
        return result( 200 );
    }

    async _start () {
        this.#nginx = new Nginx( this, {
            "listenIpFamily": this.config.listenIpFamily,
        } );

        this.#nginx.on( "exit", code => process.shutDown( { code } ) );

        const res = await this.#nginx.start();
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async _shutDown () {
        await this.#nginx.gracefulShutDown();
    }
}
