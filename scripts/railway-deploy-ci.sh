#!/usr/bin/env bash
set -euo pipefail

# Deploy backend via Railway CLI (CI) with retries and post-deploy /health/db smoke.
#
# Required env:
#   DEPLOY_TARGET=prd, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID,
#   RAILWAY_ENVIRONMENT_ID, RAILWAY_PRODUCTION_ENV_ID, RAILWAY_HEALTH_URL
# Auth: existing CLI OAuth session or RAILWAY_API_TOKEN / RAILWAY_PROJECT_TOKEN
# Optional env:
#   RAILWAY_DEPLOY_ATTEMPTS (default 3)
#   RAILWAY_HEALTH_ATTEMPTS (default 18)
#   RAILWAY_HEALTH_INTERVAL_SEC (default 10)

attempts="${RAILWAY_DEPLOY_ATTEMPTS:-3}"
health_url="${RAILWAY_HEALTH_URL:-}"
health_attempts="${RAILWAY_HEALTH_ATTEMPTS:-18}"
health_interval="${RAILWAY_HEALTH_INTERVAL_SEC:-10}"

# Reject non-production IDs and branches before auth, migrations or uploads.
node scripts/railway-deploy-preflight.mjs --offline

# CLI auth resolution.
#
# Railway distinguishes two token kinds, and the CLI reads them from different
# env vars:
#   - Project token  -> RAILWAY_TOKEN. Environment-scoped; the CLI's project-token
#     auth path. `railway up` uses it directly.
#   - Account/team token -> RAILWAY_API_TOKEN, used together with explicit
#     `railway up --project/--service/--environment` flags.
#
# An account/team token must NOT be placed in RAILWAY_TOKEN: the CLI then treats
# it as a project token and rejects it with "Unauthorized" — this was the root
# cause of the persistently failing development deploy, where the workflow set
# RAILWAY_TOKEN=${RAILWAY_API_TOKEN}. Prefer a real project token when present;
# otherwise use the account/team token via RAILWAY_API_TOKEN with RAILWAY_TOKEN
# cleared.
if [ -n "${RAILWAY_PROJECT_TOKEN:-}" ]; then
  export RAILWAY_TOKEN="${RAILWAY_PROJECT_TOKEN}"
  unset RAILWAY_API_TOKEN || true
elif [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  # Account/team token path: the CLI authenticates via RAILWAY_API_TOKEN and the
  # explicit --project/--service/--environment flags below. RAILWAY_TOKEN must be
  # cleared so the CLI does not misinterpret the account token as a project token.
  unset RAILWAY_TOKEN || true
elif [ -n "${RAILWAY_TOKEN:-}" ]; then
  # Caller supplied a genuine project token directly in RAILWAY_TOKEN.
  :
else
  # Manual deployments may use the existing Railway CLI OAuth session.
  :
fi

pnpm --dir backend run migrate:verify

if [ -n "${RAILWAY_API_TOKEN:-}${RAILWAY_TOKEN:-}" ]; then
  node scripts/railway-deploy-preflight.mjs
fi

railway_up() {
  if railway up --help 2>&1 | grep -q -- '--project'; then
    railway up \
      --project "${RAILWAY_PROJECT_ID}" \
      --service "${RAILWAY_SERVICE_ID}" \
      --environment "${RAILWAY_ENVIRONMENT_ID}" \
      --detach
  else
    echo "Railway CLI lacks explicit project targeting; upgrade it before deployment."
    return 1
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
