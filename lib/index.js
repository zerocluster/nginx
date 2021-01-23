const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );

const BASE_DIR = "/var/lib/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";
const DEFAULT_VHOST_CONF_PATH = VHOSTS_DIR + "/_default.nginx.conf";

module.exports = class {
    #proc;

    run () {

        // create dirs
        if ( !fs.existsSync( BASE_DIR ) ) fs.mkdirSync( BASE_DIR, { "recursive": true } );
        if ( !fs.existsSync( CACHE_DIR ) ) fs.mkdirSync( CACHE_DIR, { "recursive": true } );
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.mkdirSync( VHOSTS_DIR, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/nginx.conf", "utf8" ), {
            "base_dir": BASE_DIR,
            "vhosts_dir": VHOSTS_DIR,
        } );

        // deploy nginx config
        fs.writeFileSync( CONF_PATH, conf );

        // generate default vhost config
        const defaultVhostConf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost-default.nginx.conf", "utf8" ), {
            "listen_v6": false,
        } );

        // deploy default vhost config
        fs.writeFileSync( DEFAULT_VHOST_CONF_PATH, defaultVhostConf );

        // test config
        if ( !this.test() ) return;

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

        let watch = true;

        // watch for changes
        fs.watch( VHOSTS_DIR, { "persistent": false }, ( event, filename ) => {
            console.log( `config "${filename}": ${event}` );

            if ( watch ) {
                watch = false;

                setTimeout( () => {
                    watch = true;

                    this.reloadConfig();
                }, 100 );
            }
        } );

        console.log( `nginx started` );
    }

    test () {
        try {
            child_process.execFileSync( "nginx", ["-t", "-c", CONF_PATH], { "stdio": "inherit" } );

            return true;
        }
        catch ( e ) {
            return;
        }
    }

    terminate () {
        console.log( "TERM signal received..." );

        this.#proc.kill( "SIGTERM" );
    }

    gracefulShutdown () {
        this.#proc.kill( "SIGQUIT" );
    }

    reloadConfig () {
        if ( !this.test() ) return;

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
