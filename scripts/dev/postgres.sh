#!/usr/bin/env bash
# Local Postgres for development: trust auth, data in .data/postgres.
set -euo pipefail

PGDATA=".data/postgres"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  initdb -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
fi
mkdir -p .data/postgres-socket
exec postgres -D "$PGDATA" -h 127.0.0.1 -p 5432 -k "$PWD/.data/postgres-socket"
