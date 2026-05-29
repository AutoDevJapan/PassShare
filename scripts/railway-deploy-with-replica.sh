#!/usr/bin/env bash
set -euo pipefail

# Deploy backend after optional DB replica step.
#
# Required env:
#   DEPLOY_TARGET — dev | stg | prd
#   RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID
#   RAILWAY_ENVIRONMENT_ID, RAILWAY_HEALTH_URL
#
# Optional:
#   DB_REPLICA_MODE — refresh | snapshot | skip (default skip)
#   DB_REPLICA_SOURCE — prd (default)
#   DB_REPLICA_TARGET — dev | stg (required when DB_REPLICA_MODE=refresh)

deploy_target="${DEPLOY_TARGET:?DEPLOY_TARGET is required}"
replica_mode="${DB_REPLICA_MODE:-skip}"

echo "Deploy target: ${deploy_target}, DB replica mode: ${replica_mode}"

if [ "$replica_mode" = "refresh" ]; then
  replica_target="${DB_REPLICA_TARGET:?DB_REPLICA_TARGET required for refresh}"
  node scripts/railway-db-replica.mjs refresh \
    --source "${DB_REPLICA_SOURCE:-prd}" \
    --target "$replica_target"
elif [ "$replica_mode" = "snapshot" ]; then
  node scripts/railway-db-replica.mjs snapshot \
    --source "${DB_REPLICA_SOURCE:-prd}"
elif [ "$replica_mode" != "skip" ]; then
  echo "Unknown DB_REPLICA_MODE: ${replica_mode}"
  exit 1
fi

bash scripts/railway-deploy-ci.sh
