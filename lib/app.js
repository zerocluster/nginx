import App from "#core/app";

export default class extends App {

    // propeties
    get location () {
        return import.meta.url;
    }

    // protected
    async _init () {
        return result( 200 );
    }

    async _start () {
        await this.nginx.addServer( "test", {
            "serverNames": ["httpbin1.softvisio.net"],
            "upstreams": ["123.0.0.3"],
        } );

        return result( 200 );
    }
}
