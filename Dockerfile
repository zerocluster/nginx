FROM ghcr.io/zerocluster/node/app

ARG NGINX_VERSION

RUN \
    apt-get update && apt-get install -y nginx-$NGINX_VERSION \
    \
    # install dependencies
    && NODE_ENV=production npm install-clean \
    \
    # cleanup
    && /bin/bash <(curl -fsSL https://raw.githubusercontent.com/softvisio/scripts/main/env-build-node.sh) cleanup
