#!/usr/bin/env bash
set -euo pipefail

# Deploy backend via Railway CLI (CI) with retries and post-deploy /health/db smoke.
#
# Required env:
#   RAILWAY_API_TOKEN or RAILWAY_PROJECT_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
# Optional env:
#   RAILWAY_DEPLOY_ATTEMPTS (default 3)
#   RAILWAY_HEALTH_URL — e.g. https://pass-share-backend-preview.up.railway.app/health/db
#   RAILWAY_HEALTH_ATTEMPTS (default 18)
#   RAILWAY_HEALTH_INTERVAL_SEC (default 10)

attempts="${RAILWAY_DEPLOY_ATTEMPTS:-3}"
health_url="${RAILWAY_HEALTH_URL:-}"
health_attempts="${RAILWAY_HEALTH_ATTEMPTS:-18}"
health_interval="${RAILWAY_HEALTH_INTERVAL_SEC:-10}"

# CLI auth — project token preferred; account token works with @railway/cli v3 + --project flags
if [ -n "${RAILWAY_TOKEN:-}" ]; then
  :
elif [ -n "${RAILWAY_PROJECT_TOKEN:-}" ]; then
  export RAILWAY_TOKEN="${RAILWAY_PROJECT_TOKEN}"
elif [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  export RAILWAY_TOKEN="${RAILWAY_API_TOKEN}"
else
  echo "Missing RAILWAY_TOKEN, RAILWAY_PROJECT_TOKEN, or RAILWAY_API_TOKEN"
  exit 1
fi

pnpm --dir backend run migrate:verify

node scripts/railway-deploy-preflight.mjs

# v3 account token: explicit login before deploy
if ! railway whoami >/dev/null 2>&1; then
  railway login --token "${RAILWAY_TOKEN}" --browserless
fi

railway_up() {
  if railway up --help 2>&1 | grep -q -- '--project'; then
    railway up \
      --project "${RAILWAY_PROJECT_ID}" \
      --service "${RAILWAY_SERVICE_ID}" \
      --environment "${RAILWAY_ENVIRONMENT_ID}" \
      --detach
  else
    railway up --detach
  fi
}

deploy_ok=0
for i in $(seq 1 "$attempts"); do
  echo "Railway deploy attempt ${i}/${attempts}..."
  if railway_up; then
    deploy_ok=1
    break
  fi
  if [ "$i" -lt "$attempts" ]; then
    echo "Deploy failed; waiting 30s before retry..."
    sleep 30
  fi
done

if [ "$deploy_ok" -ne 1 ]; then
  echo "Railway deploy failed after ${attempts} attempt(s)."
  exit 1
fi

if [ -z "$health_url" ]; then
  echo "RAILWAY_HEALTH_URL not set; skipping post-deploy smoke."
  exit 0
fi

echo "Post-deploy smoke: ${health_url}"
for i in $(seq 1 "$health_attempts"); do
  status="$(curl -sS -o /tmp/railway-health-body.json -w '%{http_code}' "$health_url" || true)"
  if [ "$status" = "200" ]; then
    cat /tmp/railway-health-body.json
    echo
    echo "Post-deploy /health/db OK"
    exit 0
  fi
  echo "Attempt ${i}/${health_attempts}: HTTP ${status}"
  if [ -f /tmp/railway-health-body.json ]; then
    cat /tmp/railway-health-body.json || true
    echo
  fi
  sleep "$health_interval"
done

echo "Post-deploy /health/db failed after ${health_attempts} attempt(s)."
exit 1
