# Introduction

Fully automated HTTP load balancer and cache for Docker Swarm.

## Install

```sh
docker pull ghcr.io/zerocluster/nginx
```

## Usage

Use docker swarm file, provided in this repository.

```sh
# mark node, where load balancer will be deployed
docker node update --label-add nginx=true <NODE-NAME>

# deploy load balancer service
docker stack deploy --with-registry-auth -c docker-stack.yaml nginx
```

## Debug

```sh
docker run --rm -it --network main -p 80:80 -v /var/local/zerocluster/nginx:/var/local -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/zerocluster/node
```

```sh
apt update && apt install -y htop mc nginx-latest && npx update-core
```

## Configuration measurement units

<https://nginx.org/en/docs/syntax.html>.

Sizes can be specified in bytes, kilobytes (suffixes `"k"` and `"K"`) or megabytes (suffixes `"m"` and `"M"`), for example, “1024”, “8k”, “1m”.

Offsets may be also specified in gigabytes using `"g"` or `"G"` suffixes.

Time intervals can be specified in milliseconds, seconds, minutes, hours, days and so on, using the following suffixes:

- `"ms"` milliseconds
- `"s"` seconds
- `"m"` minutes
- `"h"` hours
- `"d"` days
- `"w"` weeks
- `"M"` months, 30 days
- `"y"` years, 365 days

Multiple units can be combined in a single value by specifying them in the order from the most to the least significant, and optionally separated by whitespace. For example, “1h 30m” specifies the same time as “90m” or “5400s”. A value without a suffix means seconds. It is recommended to always specify a suffix.

Some of the time intervals can be specified only with a seconds resolution.
