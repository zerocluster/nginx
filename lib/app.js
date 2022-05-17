import App from "#core/app";
import config from "#lib/app.config";
import Nginx from "#lib/nginx";

export default class extends App {
    constructor () {
        super( import.meta.url, config );
    }

    // static
    static cli () {
        return {
            "options": {},
            "arguments": {},
        };
    }

    // public
    async run () {
        const res = await super.run();

        if ( !res.ok ) return res;

        this.nginx = new Nginx( {
            "listenIpFamily": process.env.APP_LISTEN_IP_FAMILY ? +process.env.APP_LISTEN_IP_FAMILY : null,
        } );

        this.nginx.on( "exit", code => process.exit( code ) );

        await this.nginx.run();

        return res;
    }

    // protected
    _terminate () {}
}
