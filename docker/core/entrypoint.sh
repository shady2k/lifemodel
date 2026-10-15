#!/bin/sh
set -eu
: "${LIFEMODEL_DB_USERNAME:?LIFEMODEL_DB_USERNAME is required}"
: "${LIFEMODEL_DB_PASSWORD:?LIFEMODEL_DB_PASSWORD is required}"
if [ "${1:-}" = migrate ]; then
  export DATABASE_URL="$(node -e 'const e = encodeURIComponent; process.stdout.write(`postgresql://${e(process.env.LIFEMODEL_DB_USERNAME)}:${e(process.env.LIFEMODEL_DB_PASSWORD)}@lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel`)')"
  exec node /opt/lifemodel/scripts/apply-migrations.js
fi
: "${LIFEMODEL_VALKEY_PASSWORD:?LIFEMODEL_VALKEY_PASSWORD is required}"
export LIFEMODEL_DATABASE_URL="$(node -e 'const e = encodeURIComponent; process.stdout.write(`postgresql://${e(process.env.LIFEMODEL_DB_USERNAME)}:${e(process.env.LIFEMODEL_DB_PASSWORD)}@lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel`)')"
export LIFEMODEL_VALKEY_URL="$(node -e 'const e = encodeURIComponent; process.stdout.write(`redis://:${e(process.env.LIFEMODEL_VALKEY_PASSWORD)}@valkey.lifemodel-state.svc.cluster.local:6379`)')"
exec node /opt/lifemodel/dist/index.js
