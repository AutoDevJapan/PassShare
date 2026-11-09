# Authenticated support receipt intake

`POST /api/support-receipts` accepts only `requestId` (UUID), `kind`
(technical/export/cancellation/refund), numeric dotted `version`, `platform`
(web/windows/android/ios/extension), and an empty or public `PSnnn` error code.
Use the existing session and CSRF rules. Free text, credentials and extra fields
are rejected by Rust. Do not submit password box content.

The receipt belongs to the authenticated user. Repeating the same request ID
and metadata returns the same receipt; changing metadata returns 409.
`GET /api/support-receipts/:id` returns status to that user only. PostgreSQL
persists the receipt across service restarts; local memory is not durable.

A receipt means request received, not cancellation completed, refund authorized,
payment made, contract accepted, export permission granted, or data deleted.
This API does not deliver mail to the operator or expose an operator work queue.
Those paths, receipt status updates and the contract lifecycle remain required
for OPS-01/M8 completion. On account retirement, receipt rows are deleted by the
user foreign-key cascade; a customer-facing retention contract is not invented.

Tests: Rust fixed-field rejection; real HTTP actor isolation, idempotent retries,
changed-body conflict, unknown/secret-field rejection; PostgreSQL second-instance
read in the existing isolated CI database.
