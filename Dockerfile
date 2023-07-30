FROM ghcr.io/zerocluster/node/app

RUN \
    apt-get update && apt-get install -y nginx-latest \
    \
    # install deps
    && npm i --omit=dev \
    \
    # cleanup
    && /bin/bash <(curl -fsSL https://raw.githubusercontent.com/softvisio/scripts/main/env-build-node.sh) cleanup
