const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );

const BASE_DIR = "/var/run/nginx";
const VHOSTS_DIR = BASE_DIR + "/vhost";
const SOCKS_DIR = BASE_DIR + "/sock";
const CONF_PATH = BASE_DIR + "/nginx.conf";

module.exports = class {
    #proc;

    async run () {

        // create dirs
        if ( !fs.existsSync( BASE_DIR ) ) fs.mkdirSync( BASE_DIR, { "recursive": true } );
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.mkdirSync( VHOSTS_DIR, { "recursive": true } );
        if ( !fs.existsSync( SOCKS_DIR ) ) fs.mkdirSync( SOCKS_DIR, { "recursive": true } );

        // generate config
        const conf = await ejs.renderFile( __dirname + "/../resources/tmpl/nginx.conf", { BASE_DIR, VHOSTS_DIR } );
        fs.writeFileSync( CONF_PATH, conf );

        // deploy default vhost
        fs.copyFileSync( __dirname + "/../resources/tmpl/vhost-default.nginx.conf", VHOSTS_DIR + "/_vhost-default.nginx.conf" );

        // run server
        this.#proc = child_process.spawn( "nginx", ["-c", CONF_PATH], { "stdio": "inherit", "detached": true } );

        // setup signal handlers
        process.on( "SIGINT", this.terminate.bind( this ) );
        process.on( "SIGTERM", this.terminate.bind( this ) );
        process.on( "SIGQUIT", this.gracefulShutdown.bind( this ) );
        process.on( "SIGHUP", this.reloadConfig.bind( this ) );
        process.on( "SIGUSR1", this.reopenLogFiles.bind( this ) );
        process.on( "SIGUSR2", this.upgradeExe.bind( this ) );
        process.on( "SIGWINCH", this.gracefulShutdownWorkers.bind( this ) );

        // watch for changes
        fs.watch( VHOSTS_DIR, { "persistent": false }, this.reloadConfig.bind( this ) );
    }

    terminate () {
        console.log( "TERM signal received..." );

        this.#proc.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        this.#proc.kill( "SIGQUIT" );
    }

    reloadConfig () {
        console.log( `Config reloaded.` );

        this.#proc.kill( "SIGHUP" );
    }

    reopenLogFiles () {
        this.#proc.kill( "SIGUSR1" );
    }

    upgradeExe () {
        this.#proc.kill( "SIGUSR2" );
    }

    gracefulShutdownWorkers () {
        this.#proc.kill( "SIGWINCH" );
    }
};
