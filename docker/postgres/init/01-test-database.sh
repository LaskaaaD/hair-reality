#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
SELECT 'CREATE DATABASE hair_reality_test OWNER hair_reality'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hair_reality_test')\gexec
SQL
