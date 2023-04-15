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
        var res;

        res = await super._init();
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async _run () {
        this.#nginx = new Nginx( {
            "listenIpFamily": this.config.listenIpFamily,
        } );

        this.#nginx.on( "exit", code => global.shutdown.gracefulShutDown( { code } ) );

        await this.#nginx.run();

        return super._run();
    }
}
