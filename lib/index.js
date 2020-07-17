const fs = require( "fs" ),
    child_process = require( "child_process" );

module.exports = class {
    #proc;

    async run () {
        const dataDir = ".",
            dbDir = dataDir + "/db";

        const uid = +child_process.execFileSync( "id", ["-u", "postgres"], { "encoding": "utf8" } ).trim(),
            gid = +child_process.execFileSync( "id", ["-g", "postgres"], { "encoding": "utf8" } ).trim();

        // init db dir
        if ( !fs.existsSync( dataDir ) ) fs.mkdirSync( dataDir, { "recurcive": true } );
        fs.chownSync( dataDir, uid, gid );

        // init db
        if ( !fs.existsSync( dbDir + "/PG_VERSION" ) ) {
            const pwfile = dataDir + "/pgsql-password.txt";

            let superuserPassword;

            if ( process.env.PGSQL_POSTGRES_PASSWORD != null ) {
                superuserPassword = process.env.PGSQL_POSTGRES_PASSWORD;
            }
            else {
                superuserPassword = require( "crypto" ).randomBytes( 32 ).toString( "hex" );

                console.log( `GENERATED POSTGRES PASSWORD: ${superuserPassword}` );
            }

            fs.writeFileSync( pwfile, superuserPassword );
            fs.chownSync( pwfile, uid, gid );

            child_process.execFileSync( "initdb", ["--encoding", "UTF8", "--no-locale", "-U", "postgres", "--pwfile", pwfile, "-D", dbDir], { uid, gid } );

            fs.unlinkSync( pwfile );
        }

        // write pg_hba.conf
        fs.writeFileSync( dbDir + "/pg_hba.conf",
            [
                "local all all trust", // trust any user, connected via unix socket
                "host all all 0.0.0.0/0 md5", // require password, when user is connected via TCP
            ].join( "\n" ) );

        // create "conf.d" dir
        if ( !fs.existsSync( dbDir + "/conf.d" ) ) {
            fs.mkdirSync( dbDir + "/conf.d", { "recurcive": true } );
            fs.chownSync( dbDir + "/conf.d", uid, gid );

            // move "postgresql.conf"
            fs.copyFileSync( dbDir + "/postgresql.conf", dbDir + "/conf.d/000-postgresql.conf" );
            fs.chownSync( dbDir + "/conf.d/000-postgresql.conf", uid, gid );

            fs.writeFileSync( dbDir + "/postgresql.conf", "include_dir = 'conf.d'" );
            fs.chownSync( dbDir + "/postgresql.conf", uid, gid );
        }

        // default settings
        fs.writeFileSync( dbDir + "/conf.d/100-init.conf",
            [

                // listen
                "listen_addresses = '*'",
                "unix_socket_directories = '/var/run/postgresql'",

                // extensions
                "shared_preload_libraries = 'timescaledb'",
            ].join( "\n" ) );
        fs.chownSync( dbDir + "/conf.d/100-init.conf", uid, gid );

        // create and prepare unix socket dir
        if ( !fs.existsSync( "/var/run/postgresql" ) ) fs.mkdirSync( "/var/run/postgresql", { "recurcive": true } );
        fs.chownSync( "/var/run/postgresql", uid, gid );

        // run server
        this.#proc = child_process.spawn( "postgres", ["-D", dbDir], { uid, gid, "stdio": "inherit", "detached": true } );

        process.on( "SIGINT", this._onTerm.bind( this ) );
        process.on( "SIGTERM", this._onTerm.bind( this ) );
    }

    _onTerm () {
        console.log( "TERM signal received..." );

        this.#proc.kill( "SIGTERM" );
    }
};
