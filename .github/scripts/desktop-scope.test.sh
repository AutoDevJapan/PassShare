#!/usr/bin/env bash
# Run the actual classifier against independent path fixtures. Only Git's diff
# producer is substituted; no real checkout, hook, credential or ref is changed.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temp_base="$(realpath "${TMPDIR:-/tmp}")"
scratch="$(mktemp -d "$temp_base/passshare-desktop-scope.XXXXXX")"
scratch="$(realpath "$scratch")"
cleanup() {
  case "$scratch" in "$temp_base"/passshare-desktop-scope.*) rm -r -- "$scratch" ;; *) return 1 ;; esac
}
trap cleanup EXIT
export DESKTOP_SCOPE_FIXTURE="$scratch/fixture"
git() {
  if [[ "${DESKTOP_SCOPE_DIFF_FAILURE:-false}" == true ]]; then return 47; fi
  [[ "$1" == diff && "$2" == --no-renames && "$3" == --name-only && "$4" == -z ]]
  cat "$DESKTOP_SCOPE_FIXTURE"
}
export -f git
export RUNNER_TEMP="$scratch"
export GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export GITHUB_OUTPUT="$scratch/outputs"
export GITHUB_STEP_SUMMARY="$scratch/summary"
case_check() {
  local name="$1" event="$2" base="$3" want_desktop="$4" want_mobile="$5"
  shift 5
  : > "$DESKTOP_SCOPE_FIXTURE"
  if (( $# )); then printf '%s\0' "$@" > "$DESKTOP_SCOPE_FIXTURE"; fi
  : > "$GITHUB_OUTPUT"; : > "$GITHUB_STEP_SUMMARY"
  EVENT_NAME="$event" BASE_SHA="$base" bash "$script_dir/desktop-scope.sh"
  grep -qx "desktop=$want_desktop" "$GITHUB_OUTPUT"
  grep -qx "mobile=$want_mobile" "$GITHUB_OUTPUT"
  printf 'scope control passed: %s\n' "$name"
}
base=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
case_check backend-pr pull_request "$base" false true backend/src/commercial-live.js
case_check backend-main-push push "$base" false true backend/src/commercial-live.js
case_check backend-verification-docs pull_request "$base" false true backend/test/commercial-seat-decreases.test.js tools/restore-drill-rs/src/scenario.rs tools/encrypted-storage-acceptance/src/encrypted_restore.rs documents/spec/commercial-lifecycle.md
case_check lifecycle-retention-doc-only pull_request "$base" false false documents/spec/support-data-lifecycle.md
case_check deletion-api-with-retention-doc pull_request "$base" false true backend/src/commercial-data-deletion.js documents/spec/support-data-lifecycle.md
case_check verification-only push "$base" false false tools/restore-drill-rs/Cargo.toml
case_check private-snapshot-helper pull_request "$base" false false tools/prd-snapshot-go/main.go .github/workflows/private-prd-snapshot.yml
case_check production-deployment push "$base" false false .github/workflows/deploy-prd.yml
case_check desktop pull_request "$base" true false apps/desktop/src/main.ts
case_check desktop-runbook-only pull_request "$base" false false documents/runbooks/desktop-release.md
case_check runbook-backup pull_request "$base" true true documents/runbooks/desktop-release.md.bak
case_check runbook-mdx pull_request "$base" true true documents/runbooks/desktop-release.mdx
case_check runbook-case pull_request "$base" true true documents/runbooks/Desktop-release.md
case_check runbook-subdirectory pull_request "$base" true true documents/runbooks/nested/desktop-release.md
case_check staging-runbook pull_request "$base" true true documents/runbooks/staging-acceptance.md
case_check runbook-with-runtime pull_request "$base" true false documents/runbooks/desktop-release.md apps/desktop/src/main.ts
case_check shared-rust pull_request "$base" true true crates/passshare-connect/src/lib.rs
case_check cargo-lock push "$base" true true Cargo.lock
case_check wasm-assets pull_request "$base" true true frontend/public/cloud-crypto/passshare_cloud_wasm_bg.wasm
case_check build-definition push "$base" true true .github/workflows/desktop-build.yml
case_check classifier-definition pull_request "$base" true true .github/scripts/desktop-scope.sh
case_check desktop-renamed-away pull_request "$base" true true apps/desktop/src/old.ts backend/src/old.ts
case_check unknown pull_request "$base" true true unknown-input
case_check missing-base push "" true true backend/src/commercial-live.js
case_check zero-base push 0000000000000000000000000000000000000000 true true backend/src/commercial-live.js
case_check no-change pull_request "$base" false false
: > "$GITHUB_OUTPUT"
if DESKTOP_SCOPE_DIFF_FAILURE=true BASE_SHA="$base" bash "$script_dir/desktop-scope.sh"; then
  printf 'diff failure must fail closed\n' >&2; exit 1
else
  status=$?
  [[ "$status" == 47 && ! -s "$GITHUB_OUTPUT" ]]
fi
printf 'scope controls: 27 passed\n'
