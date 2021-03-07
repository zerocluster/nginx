const os = require( "os" );
const fs = require( "fs" );
const child_process = require( "child_process" );
const ejs = require( "ejs" );
const Docker = require( "dockerode" );

const BASE_DIR = os.platform() === "win32" ? process.env.LOCALAPPDATA + "/share/nginx" : "/var/lib/share/nginx";
const CACHE_DIR = BASE_DIR + "/cache";
const VHOSTS_DIR = BASE_DIR + "/vhosts";
const CONF_PATH = BASE_DIR + "/nginx.conf";

module.exports = class Nginx {
    #listenV6;
    #docker;
    #proc;
    #vhosts = {};

    // XXX setup swarm service create, remove, update listener
    async run () {
        this.#docker = new Docker( { "socketPath": "/var/run/docker.sock" } );

        // remove all vhosts
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.rmSync( VHOSTS_DIR, { "recursive": true, "force": true } );

        // init
        if ( !fs.existsSync( BASE_DIR ) ) fs.mkdirSync( BASE_DIR, { "recursive": true } );
        if ( !fs.existsSync( CACHE_DIR ) ) fs.mkdirSync( CACHE_DIR, { "recursive": true } );
        if ( !fs.existsSync( VHOSTS_DIR ) ) fs.mkdirSync( VHOSTS_DIR, { "recursive": true } );

        // generate nginx config
        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/nginx.conf", "utf8" ), {
            "base_dir": BASE_DIR,
            "vhosts_dir": VHOSTS_DIR,
            "listen_v6": this.#listenV6,
        } );

        // deploy nginx config
        fs.writeFileSync( CONF_PATH, conf );

        // init vhosts
        const services = await this.#docker.listServices();

        for ( const service of services ) {
            if ( !service.Spec.Labels["net.softvisio.loadbalancer-server-name"] ) continue;

            this.#addVhost( service.ID, service.Spec.Labels["net.softvisio.loadbalancer-server-name"] );
        }

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

        // refresh upstreams
        await this.#refreshUpstreams();

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

    #removeVhost ( id ) {
        if ( !this.#vhosts[id] ) return;

        fs.unlinkFileSync( VHOSTS_DIR + "/" + id + ".nginx.conf" );

        delete this.#vhosts[id];
    }

    #addVhost ( id, serverName ) {
        if ( this.#vhosts[id] === serverName ) return;

        this.#vhosts[id] = serverName;

        const conf = ejs.render( fs.readFileSync( __dirname + "/../resources/tmpl/vhost.nginx.conf", "utf8" ), {
            id,
            "listen_v6": this.#listenV6,
            "server_name": serverName,
            "cache_dir": CACHE_DIR,
        } );

        fs.writeFileSync( VHOSTS_DIR + "/" + id + ".nginx.conf", conf );
    }

    async #refreshUpstreams () {

        // const tasks = await this.#docker.listTasks();
        // for ( const task of tasks ) {
        // const id = task.ID;
        // this.#tasks[id] = {
        //     id,
        //     service_id: task.ServiceID,
        //     node_id: task.NodeID,
        //     state: task.Status.State,
        //     desired_state: task.DesiredState,
        //     service: this.#services[task.ServiceID],
        //     networks: Object.fromEntries(
        //         task.NetworksAttachments.map(network => {
        //             const name = network.Network.Spec.Name;
        //             const address = network.Addresses[0];
        //             // const isIngress = !!network.Network.Spec.Ingress;
        //             return [name, address];
        //         })
        //     ),
        // };
        // console.log(this.#tasks);
        // }
    }
};
