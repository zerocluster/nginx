FROM ghcr.io/zerocluster/node/app

ARG NGINX_VERSION

RUN \
    --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN \
    \
    apt-get update && apt-get install -y nginx-$NGINX_VERSION \
    \
    # install dependencies
    && NODE_ENV=production npm install-clean \
    \
    # cleanup
    && script=$(curl -fsSL "https://raw.githubusercontent.com/softvisio/scripts/main/env-build-node.sh") \
    && bash <(echo "$script") cleanup
