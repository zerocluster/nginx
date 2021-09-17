# Changelog

### 2.5.18 (2021-09-17)

Fixes:

-   fix: docker devel tag removed
-   fix: package renamed

### 2.5.17 (2021-09-12)

Fixes:

-   fix: docker autobuild_tags renamed to auto_tags

### 2.5.16 (2021-09-07)

Fixes:

-   fix: docker autobuild tags

### 2.5.15 (2021-09-06)

No significant changes since the previous release

### 2.5.14 (2021-09-03)

Fixes:

-   fix: dockerfile cleanup

### 2.5.13 (2021-08-30)

Changed:

-   docker base image changed to softvisio/node

### 2.5.12 (2021-07-05)

Fixed:

-   docker stack databases volume removed

### 2.5.11 (2021-07-05)

Fixed:

-   code improvements

### 2.5.10 (2021-06-22)

Changed:

-   tmpl -> templates;
-   moved to github;

Fixed:

-   changelog updated;

### 2.5.9 (2021-06-01)

Changed:

-   lint config removed;

### 2.5.8 (2021-05-19)

Changed:

-   lint script removed;

### 2.5.7 (2021-04-25)

Changed:

-   nginx mainline -> latest;

### 2.5.6 (2021-04-17)

Changed:

-   ported to modules;

### 2.5.5 (2021-04-01)

Changed:

-   volume name fixed;

### 2.5.4 (2021-04-01)

Changed:

-   maxmind renamed to databases;

### 2.5.3 (2021-03-31)

Changed:

-   lint pattern updated;

### 2.5.2 (2021-03-15)

Changed:

-   package renamed;

### 2.5.1 (2021-03-15)

Changed:

-   docker tags updated;

### 2.5.0 (2021-03-15)

Changed:

-   config files renamed;

### 2.4.2 (2021-03-15)

Changed:

-   shared memory fix;

### 2.4.1 (2021-03-14)

Changed:

-   contrib dir removed;

### 2.4.0 (2021-03-14)

Changed:

-   env updated;
-   docker stack hostname removed;

### 2.3.1 (2021-03-13)

Changed:

-   services reload fixed;

### 2.3.0 (2021-03-13)

Changed:

-   more configuretion settings added;
-   nginx server name label changed;

### 2.2.1 (2021-03-11)

Changed:

-   labels compare fix;

### 2.2.0 (2021-03-11)

Changed:

-   dynamic peers;

### 2.1.0 (2021-03-10)

Changed:

-   dynamic upstreams support removed;
-   disable healthcheck;
-   docker stack updated;

### 2.0.8 (2021-03-10)

Changed:

-   docker-compose.yaml renamed to docker-stack.yaml;

### 2.0.7 (2021-03-09)

Changed:

-   cache remove fixed;

### 2.0.6 (2021-03-09)

Changed:

-   remove cache for destroyed services;
-   upstream settings updated;

### 2.0.5 (2021-03-08)

Changed:

-   docker-compose.yaml shebang added;

### 2.0.4 (2021-03-08)

Changed:

-   volume name fixed;
-   deploy instructions added;

### 2.0.3 (2021-03-08)

Changed:

-   deploy instructions added;
-   build tags updated;

### 2.0.2 (2021-03-08)

Changed:

-   make package private;

### 2.0.1 (2021-03-08)

Changed:

-   build tasg updated;

### 2.0.0 (2021-03-08)

Changed:

-   swarm loadbalancer;

### 1.1.1 (2021-03-03)

Changed:

-   template path fixed;

### 1.1.0 (2021-03-03)

Changed:

-   package published;
-   load balancer config template added;
-   package renamed;
-   vhosts methods added;

### 1.0.2 (2021-02-17)

Changed:

-   package-lock removed;

### 1.0.1 (2021-02-11)

Changed:

-   use docker-wrapper script;
-   deps updated;

### 1.0.0 (2021-02-02)

-   stable release;

### 0.9.1 (2021-01-27)

-   deps updated

### 0.9.0 (2021-01-26)

-   migrated to node v15

### 0.8.0 (2021-01-23)

-   log messages updated
-   nginx config updated
-   nginx location set to /var/lib

### 0.7.1 (2021-01-22)

-   do not override default vhost config

### 0.7.0 (2020-11-30)

-   default vhost renamed

### 0.6.1 (2020-11-16)

-   docker mirrors updated

### 0.6.0 (2020-10-22)

-   docker tags updated

### 0.5.0 (2020-10-01)

-   docker --init

### 0.4.10 (2020-09-19)

-   docker mirrors

### 0.4.9 (2020-09-18)

-   docker mirrors added

### 0.4.8 (2020-09-05)

-   deps updated

### 0.4.7 (2020-08-07)

-   shrinkwrap replaced with package-lock
-   .eslintrc.yaml removed

### 0.4.6 (2020-08-03)

-   npm-shrinkwrap.json version updated

### 0.4.5 (2020-08-03)

-   shrinkwrap added

### 0.4.4 (2020-07-31)

-   vhost renamed to vhosts

### 0.4.3 (2020-07-31)

-   create cache dir on startup

### 0.4.2 (2020-07-30)

-   docker remove npm cache

### 0.4.1 (2020-07-21)

-   hide uWebSockets header

### 0.4.0 (2020-07-19)

-   proxy cache fixed
-   nginx config updated
-   docker always restart unless stopped
-   gzip types fixed

### 0.3.0 (2020-07-18)

-   nginx confing updated
-   .sh ext removed from docker wrapper
-   moved common dockerfile instructions to the base image
-   project location in docker renamed to /var/local/dist
-   docker CONTAINER_NAME var added

### 0.2.0 (2020-07-18)

-   test configs before reload
-   ejs sync render

### 0.1.0 (2020-07-17)

-   init
