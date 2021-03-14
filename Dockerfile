FROM softvisio/core

HEALTHCHECK NONE

RUN \
    dnf install -y nginx-mainline \
    \
    # install deps
    && npm i --unsafe --only=prod \
    \
    # clean npm cache
    && rm -rf ~/.npm-cache
