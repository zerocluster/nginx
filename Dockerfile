FROM softvisio/node

HEALTHCHECK NONE

RUN \
    dnf install -y nginx-latest \
    \
    # install deps
    && npm i --unsafe --only=prod \
    \
    # clean npm cache
    && rm -rf ~/.npm-cache
