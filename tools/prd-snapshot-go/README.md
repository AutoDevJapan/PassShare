# Private production snapshot

This verification/deployment helper captures only the reconciled PassShare production PG18 service. It uses the existing Railway CLI authentication, never retrieves DB connection values, and does not provision a public TCP proxy, service, volume, or paid backup.

The wrapper validates the production resource IDs and clean main source. The helper checks the actual project/workspace, generates a temporary SSH identity for the same existing principal, and revokes only the ID returned by this call. Cleanup failure is a deployment failure. An existing registered identity can be used for manual OAuth capture without copying, registering, or removing it.

The database container creates a private temporary archive, checks it with its own `pg_restore`, emits the source SHA-256 and base64 bytes, then verifies temporary-file absence. The helper verifies the complete decoded bytes against that digest and creates its output without overwrite, outside the upload tree. No database content, connection value, or private identity is printed. The caller must remove the job-local archive; it must not upload it as a GitHub artifact or count it as a retained backup.

Run isolated tests with `go test ./...` and `go vet ./...` from this directory. These do not contact Railway. The production wrapper invokes the helper with `--output` inside its owned private temporary directory. A manual existing identity is supplied only through `--identity-file`.
