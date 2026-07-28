#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec gosu node node dist/server.mjs "$@"
fi

exec node dist/server.mjs "$@"
