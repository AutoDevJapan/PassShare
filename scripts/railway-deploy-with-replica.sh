#!/usr/bin/env bash
set -euo pipefail

# Existing production only. Snapshot is a temporary prd-only pg_dump, not a
# replica refresh or a retained backup. No paid backup service is provisioned.
deploy_target="${DEPLOY_TARGET:?DEPLOY_TARGET is required}"
replica_mode="${DB_REPLICA_MODE:-snapshot}"

if [ "$deploy_target" != "prd" ] || [ "${DB_REPLICA_SOURCE:-prd}" != "prd" ] || [ -n "${DB_REPLICA_TARGET:-}" ]; then
  echo "Only prd deployment and prd snapshot are supported; replica targets are retired."
  exit 1
fi
if [ "$replica_mode" != "snapshot" ] && [ "$replica_mode" != "skip" ]; then
  echo "Only snapshot or skip is supported; refresh is retired."
  exit 1
fi

node scripts/railway-deploy-preflight.mjs --offline
if [ "$replica_mode" = "snapshot" ]; then
  # Keep the dump outside the upload tree, in an owned temporary directory.
  umask 077
  DB_SNAPSHOT_DIR="$(mktemp -d)"
  export DB_SNAPSHOT_DIR
  trap 'rm -f -- "$DB_SNAPSHOT_DIR"/passshare-snapshot-replica-*.dump; rmdir -- "$DB_SNAPSHOT_DIR"' EXIT
  node scripts/railway-db-replica.mjs snapshot --source prd
fi

bash scripts/railway-deploy-ci.sh
