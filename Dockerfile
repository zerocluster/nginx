FROM softvisio/core:master

LABEL maintainer="zdm <zdm@softvisio.net>"

USER root

ENV DIST_PATH="$WORKSPACE/nginx"

ADD . $DIST_PATH

WORKDIR $DIST_PATH/data

RUN \
    dnf install -y nginx-mainline \
    \
    # install deps
    && pushd .. \
    && npm i --unsafe --only=prod \
    && popd \
    \
    # clean npm cache
    && rm -rf ~/.npm

ENTRYPOINT [ "/bin/bash", "-l", "-c", "node ../bin/main.js \"$@\"", "bash" ]
