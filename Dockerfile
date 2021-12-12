FROM zerocluster/node

RUN \
    apt update && apt install -y nginx-latest \
    \
    # install deps
    && npm i --omit=dev \
    \
    # cleanup
    && curl -fsSL https://raw.githubusercontent.com/softvisio/scripts/main/env-build-node.sh | /bin/bash -s -- cleanup
