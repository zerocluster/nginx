FROM softvisio/core:master

LABEL maintainer="zdm <zdm@softvisio.net>"

USER root

ENV DIST_PATH="$WORKSPACE/nginx"

ADD . $DIST_PATH

WORKDIR $DIST_PATH/data

RUN \
    dnf install -y nginx-mainline

ENTRYPOINT [ "/bin/bash", "-l", "-c", "node ../bin/main.js \"$@\"", "bash" ]
