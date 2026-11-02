#!/bin/sh
set -eu
mkdir -p /var/lib/hair-reality/private
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /var/lib/hair-reality/private
  exec runuser -u node -- "$@"
fi
exec "$@"
