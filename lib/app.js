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
        return result( 200 );
    }
}
