# Synthetic restore verification

`passshare-restore-drill` is a verification-only executable, **not a product CLI
or a customer recovery tool**. Independent `[workspace]`; direct dependencies
are only `serde_json` and blocking `reqwest` (JSON + rustls, defaults disabled).
The parent CI generates and retains Cargo.lock, builds and tests this crate,
and connects Docker. No local Cargo/rustc/Docker execution was performed by the
implementation worker. Tests were written before implementation; Red/Green
execution remains the parent's remote CI responsibility.

## Parent runtime contract

- Linux dedicated disposable container with `/.dockerenv`; private, unpublished
  Docker **internal** network. No host secrets, production volumes or customer
  data. The runner cannot inspect Docker/network isolation from inside it.
- PostgreSQL 16 on hostname **`postgres`**, port 5432, user `postgres`, **trust**
  auth. No passwords. No pre-existing `drill_source` or `drill_restored` databases.
- Final image: `postgres:16-bookworm` with PostgreSQL clients at
  `/usr/lib/postgresql/16/bin/{psql,pg_dump,pg_restore}`, Node 24 binary at
  `/usr/local/bin/node`, official backend (locked production dependencies) at
  `/app/src/index.js` and `/app/node_modules`, and its matching Rust mutations
  binary at `/usr/local/bin/passshare-mutations`. `/usr/bin/sha256sum` is required.
- ENTRYPOINT: `passshare-restore-drill`, **no arguments**. Standard output is
  exactly one anonymous JSON report, including on failure. Exit 0 requires all
  checks and cleanup; exit 1 means failure. Node stdout/stderr and command stderr
  are discarded. No shell, op CLI, browser or product client is launched.
- Set only these runner inputs (normal image variables such as `PATH`,
  `PG_MAJOR`, `PG_VERSION` are fine):

| Environment variable | Value |
| --- | --- |
| `PASSSHARE_RESTORE_DRILL` | `synthetic-container-v1` |
| `DRILL_SOURCE_SHA` | Source commit, exactly 40 hexadecimal characters |
| `DRILL_BACKEND_SHA256` | SHA256 of parent's sorted tracked backend/src + native file-hash list, exactly 64 hexadecimal characters |
| `PASSSHARE_DRILL_CONTROL` | Omit normally; `omit-credential-purge` for the negative control |

`metadata.backend_source_sha256` records the **source** fingerprint, not an
image digest. The entrypoint and native binary hashes are measured separately.
Do not put `DATABASE_URL`, PG connection overrides, tokens, passwords, secret
keys, proxy settings, `NODE_OPTIONS`, or native binary overrides in the runner
environment. These are refused before any child/DB operations; values are never
printed. Child environments are cleared and rebuilt using fixed synthetic DBs.
The Node child alone receives DATABASE_URL and PASSSHARE_MUTATIONS_BIN.

Upload **only the report JSON**. Snapshots/authentication-bearing API replies stay
in memory. Custom-format dump stays in a newly created private temporary directory
and is removed on success/failure. No response, item, credential or command output
is copied to reports. Errors are static anonymous classes.

## Exercise

Official HTTP signup, item creation through Rust native idempotency, sharing and
acceptance create four synthetic accounts, two complete items (Japanese additional
fields, concealed field, ordered URLs/sections/tags), and a 4-byte attachment.
Account credentials are generated per run from the container OS random source
and remain in memory and the disposable DB; no fixed account password is shipped.
All ten original tables **and** the current native `mutation_operations` table
must be present and populated. Unknown tables fail the inventory check so a schema
change requires an explicit update rather than silently omitting data.
At aea0e7b, `createApp()` awaits `createMutationStore()` before it returns/listens;
when PASSSHARE_MUTATIONS_BIN and the real pool are present, that store awaits
`nativeMutation({command: "schema"})` and `applySchemaWithAdvisoryLock()`. The
native schema creates `mutation_operations`, so inventory checking after readiness
and before signup is intentional. The idempotent item POST then populates it.

A quiescent snapshot and pg_dump precede one additional item, invitation
cancellation, member removal and SQL-simulated password change/account deletion.
First Node stop + connection refusal begins synthetic RTO. pg_restore creates a
separate DB; normalized full rows in every table are compared **before** the API
starts. Array order and every value are retained; JSON object key order is ignored.
Unsafe restore reproduces revived qualifications. Node is stopped and connection
refusal verified before SQL reconciliation: sessions/tokens/memberships deleted,
pending invitations revoked, simulated current account state applied.

The closed-service gate prevents restart if any old credential/permission remains.
After restart: old sessions/tokens/passwords return 401; unapproved reads/writes
return 403; cancelled invite acceptance returns 404. SQL inserts only the synthetic
owner membership (**not identity verification or a reapproval API**). A fresh
token reads both full items and exact attachment/metadata; PUT increments version,
stale PUT returns 409, and former member reads/writes/attachment remain 403.
The restored missing post-backup item returns 404; source full rows stay unchanged.
RTO ends after these successful reopening/read/write/denial checks, before cleanup.

Reports count **executed checks**, never the legacy 24/54. They record individual
checks/time, source/dump hashes, dump size, dump/DB-create/restore/compare/reconcile
durations, first stop to confirmed reopen RTO, last included update's HTTP commit
bracket, dump snapshot range and excluded updates range. These are tiny synthetic
service measurements, **not production RTO/RPO, Railway/PITR, backup retention,
identity verification or all-client acceptance**. RTO remains incomplete on failure.

## Remote verification and negative control

Use `cargo test --manifest-path tools/restore-drill-rs/Cargo.toml` in parent remote
CI. Tests cover guards, full JSON and fixture loss, exact negative statuses,
missing/empty snapshot data, anonymous report counts, omitted-purge reopening gate,
private temporary cleanup, and real owned child stop/reaping during panic unwind.
The ignored `tests::child_fixture` is launched only by lifecycle tests. There are
11 ordinary tests and **one ignored fixture** on Linux; report it as ignored,
never as a passed test. Test execution and actual counts must come from CI.

Run the normal container, then a separate invocation with
`PASSSHARE_DRILL_CONTROL=omit-credential-purge` on the same disposable Postgres.
Normal cleanup drops only DBs it successfully created. The control must return 1,
`completed=false`, `failure_class=check_failed`, and a failed check named
`reopen_gate_credentials_and_current_accounts_clean`. It must never reach
`reconciled_official_API_ready`; cleanup still reaps Node and removes dump/owned DBs.

CI passes both reports to the Rust validator (`--validate-report positive|negative`
on bounded stdin, no database operations). The validator requires each named
cleanup result exactly once. Negative mode refuses any reopening-ready result,
even a failed one, and requires the failed closed-service gate and incomplete
RTO. Positive mode requires the end-to-end data, write, denial, source and cleanup
results and completed synthetic RTO. Unit mutations add a premature reopening
result or remove all cleanup results; both must be rejected.
If DBs pre-exist, the runner fails instead of deleting them; parent must remove its
own disposable container/volumes/network after every run (including force termination).
