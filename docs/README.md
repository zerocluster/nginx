# Introduction

Fully automated HTTP load balancer and cache for Docker Swarm.

## Install

```shell
docker pull softvisio/nginx
```

## Usage

Use docker swarm file, provided in this repository.

```shell
# mark node, where load balancer will be deployed
docker node update --label-add nginx=true <NODE-NAME>

# deploy load balancer service
docker stack deploy --with-registry-auth -c docker-stack.yaml nginx
```

To add some docker swarm service to the load balancer you need to define service labels.

```shell
# add service to the load balancer
docker service update --label-add nginx.server-name=www.example.com <SERVICE-NAME>

# remove service from the load balancer
docker service update --label-rm nginx.server-name <SERVICE-NAME>
```

## Docker swarm labels

### nginx.server-name

-   Type: <string\>
-   Default: `""`

[https://nginx.org/en/docs/http/server_names.html](https://nginx.org/en/docs/http/server_names.html).

[https://nginx.org/en/docs/http/ngx_http_core_module.html#server_name](https://nginx.org/en/docs/http/ngx_http_core_module.html#server_name).

Sets names of a virtual server. If no server names are provided service will be ignored or removed, if was added previously.

### nginx.client-max-body-size

-   Type: <string\>
-   Default: `"10m"`

[https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

Sets the maximum allowed size of the client request body. If the size in a request exceeds the configured value, the 413 (Request Entity Too Large) error is returned to the client. Please be aware that browsers cannot correctly display this error. Setting size to 0 disables checking of client request body size.

### nginx.cache

-   Type: <string\>
-   Default: `"true"`

Enable HTTP cache.

### nginx.cache.max-size

-   Type: <string\>
-   Default: `"10g"`

[https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_path](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_path).

Maximum cache size. When the size is exceeded, it removes the least recently used data.

### nginx.cache.inactive

-   Type: <string\>
-   Default: `"1w"`

[https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_path](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_path).

Cached data that are not accessed during the time specified by the inactive parameter get removed from the cache regardless of their freshness.

### Configuration measurement units

[https://nginx.org/en/docs/syntax.html](https://nginx.org/en/docs/syntax.html).

Sizes can be specified in bytes, kilobytes (suffixes `"k"` and `"K"`) or megabytes (suffixes `"m"` and `"M"`), for example, “1024”, “8k”, “1m”.

Offsets may be also specified in gigabytes using `"g"` or `"G"` suffixes.

Time intervals can be specified in milliseconds, seconds, minutes, hours, days and so on, using the following suffixes:

-   `"ms"` milliseconds
-   `"s"` seconds
-   `"m"` minutes
-   `"h"` hours
-   `"d"` days
-   `"w"` weeks
-   `"M"` months, 30 days
-   `"y"` years, 365 days

Multiple units can be combined in a single value by specifying them in the order from the most to the least significant, and optionally separated by whitespace. For example, “1h 30m” specifies the same time as “90m” or “5400s”. A value without a suffix means seconds. It is recommended to always specify a suffix.

Some of the time intervals can be specified only with a seconds resolution.
