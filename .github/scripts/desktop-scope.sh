#!/usr/bin/env bash
# Desktop binary inputs only. API/crypto/restore/WebView integration is still
# qualified by its existing required workflows, independently of this job.
set -euo pipefail
desktop=false
mobile=false
if [[ ! "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ || "$BASE_SHA" =~ ^0+$ ]]; then
  desktop=true
  mobile=true
else
  git diff --no-renames --name-only -z "$BASE_SHA" "$GITHUB_SHA" > "$RUNNER_TEMP/passshare-paths"
  while IFS= read -r -d '' path; do
    case "$path" in
      frontend/cloud-assets.json|frontend/public/cloud-crypto/*) desktop=true; mobile=true ;;
      apps/desktop/*) desktop=true ;;
      apps/mobile/*) mobile=true ;;
      # Neither standalone verification workspace is a desktop path dependency.
      tools/restore-drill-rs/*|tools/encrypted-storage-acceptance/*|documents/spec/commercial-lifecycle.md|documents/spec/support-data-lifecycle.md|documents/runbooks/desktop-release.md) ;;
      # Production-only snapshot tooling/deployment does not enter client builds.
      tools/prd-snapshot-go/*|.github/workflows/private-prd-snapshot.yml|.github/workflows/deploy-prd.yml) ;;
      # Server changes keep API/mobile/WebView/encrypted acceptance coverage.
      backend/*) mobile=true ;;
      frontend/*|packages/extension/*|e2e/web/*|e2e/extension/*) ;;
      # Cargo/SDK/packaging and unknown inputs, including this workflow/scripts,
      # remain conservative: a changed build definition must qualify itself.
      *) desktop=true; mobile=true ;;
    esac
  done < "$RUNNER_TEMP/passshare-paths"
fi
printf 'desktop=%s\nmobile=%s\n' "$desktop" "$mobile" >> "$GITHUB_OUTPUT"
printf 'Desktop inputs affected: %s; backend/mobile inputs affected: %s\n' "$desktop" "$mobile" >> "$GITHUB_STEP_SUMMARY"
