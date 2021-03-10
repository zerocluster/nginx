FROM softvisio/core

HEALTHCHECK NONE

RUN \
    dnf install -y nginx-mainline \
    \
    # install deps
    && pushd .. \
    && npm i --unsafe --only=prod \
    && popd \
    \
    # clean npm cache
    && rm -rf ~/.npm-cache
