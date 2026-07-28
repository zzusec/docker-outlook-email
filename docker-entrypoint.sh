#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec gosu node node --require /app/warmup.cjs dist/server.mjs "$@"
fi

exec node --require /app/warmup.cjs dist/server.mjs "$@"
