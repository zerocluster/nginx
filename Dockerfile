FROM ghcr.io/zerocluster/node/app

RUN \
    apt-get update && apt-get install -y nginx-stable=1.25.3 \
    \
    # install deps
    && NODE_ENV=production npm i \
    \
    # cleanup
    && /bin/bash <(curl -fsSL https://raw.githubusercontent.com/softvisio/scripts/main/env-build-node.sh) cleanup
