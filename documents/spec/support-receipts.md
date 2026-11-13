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

Mail delivery and receipt ownership are separate checks. A receipt UUID, From
address, forwarded email header or quoted conversation is not proof of the
authenticated receipt owner's authority. Mailbox access authorizes handling
mail only; it does not authorize reading or changing application receipts.
The current API derives ownership solely from the live session and rejects
caller-supplied user IDs, email addresses, receipt IDs and status fields.
Reusing another user's request ID creates a distinct receipt for the current
user and must not attach that user to the original receipt.

Before an operator changes state or performs a sensitive request, an implemented
authenticated flow must bind the owner's current session, that owner's receipt,
the specific requested action and an authorized operator. Any confirmation used
across the mail boundary must be scoped, expiring and replay-protected; it must
not carry a session token or grant mailbox readers data access. This binding and
operator status mutation require the deployment-scoped flow below. An email reply may
confirm mail arrival, but must not claim authenticated ownership or change the
application status. Deleted receipt rows must not be recreated from old mail.

## Authenticated operator status flow

Deployment configuration `PASSSHARE_SUPPORT_OPERATOR_IDS` lists existing user
UUIDs authorized only to update support receipt state. It is empty by default.
Enrollment requires the existing deployment administrator; mailbox access,
monitoring credentials, email addresses and request headers never enroll users.
This is the operator role in the support lifecycle specification, limited to
recording receipt progress, with no payment, contract, export or deletion grant.

The owner calls `POST /api/support-receipts/:id/authorization` with `operatorId`,
the next `status` and current `revision`. A live owner session is required. The
one-time `confirmation` returned is bound to that session, operator, receipt,
revision and transition, expires after ten minutes, and replaces prior consent.
Only its SHA-256 digest is stored. It is not an account credential. Do not put
session credentials in mail. The owner may convey the scoped confirmation to
the assigned operator through the existing contact conversation.

The configured operator uses their own live session to POST only `confirmation`
to `/api/support-receipts/:id/operator-status`. PostgreSQL locks both identities,
their current sessions and the receipt, then consumes consent and increments
the revision atomically. Logout, retirement, expiry, stale revision and replay
are rejected. The transitions are received → in_progress → resolved; resolution
records support handling only and does not execute the underlying request.
The owner GET returns the same receipt and status history without operator IDs
or confirmation material. Retirement cascades the receipt, consent and history.
No operator API is available with the nonpersistent memory store.

The isolated PostgreSQL HTTP test covers positive transitions, mailbox/owner
separation, wrong actors, expiry, superseded consent, simultaneous consumption,
logout, persistent history and retirement cleanup. Production enrollment and
the end-to-end authenticated contact workflow require separate acceptance;
the earlier synthetic mail roundtrip does not demonstrate this flow.

Tests: Rust fixed-field rejection; real HTTP actor isolation, idempotent retries,
changed-body conflict, unknown/secret-field rejection; PostgreSQL second-instance
read in the existing isolated CI database.

## Shared authenticated client connection

createCloudSession exposes support.create and support.get through its existing immutable session transport. The caller retains requestId; uncertain POSTs are not automatically retried. Only the existing fixed metadata is accepted, response receipt/request identity is checked, body size is bounded, and remote diagnostics are not returned. This adds no operator enrollment, mail delivery, UI, contract or payment authority. The isolated HTTP client test verifies same-request replay, owner read, other-owner rejection and session revocation; memory-store acceptance is separate from PostgreSQL persistence and production contact integration.

共有clientの `support.authorize` は、本人sessionからoperatorId・次status・現在revisionを
既存authorization APIへ送る。応答はreceiptId・status・revisionの一致、期限の形式、
confirmationの固定形式と余分なfield不在を検査する。`support.applyStatus` は担当者自身の
sessionでconfirmationだけを既存operator-status APIへ送り、receipt IDと更新版を検査する。
不明なPOST結果は自動再送しない。認可発行の応答喪失では確認値をGETで復元できないため、
本人が現在revisionを取得して再認可し、旧同意を置換する。担当者更新の応答喪失では、
担当者が本人用GETを代行せず、本人sessionのGETでstatus/revisionを照合する。
確認値をログや永続client保存へ
出さない。この接続はoperator登録・mail配送・UI・契約や決済の操作権限を追加しない。
専用PG/実HTTPでは本人同意、担当者消費、他actor拒否、再送拒否、旧revision拒否と履歴を
共有client経由で確認する。本番担当者・窓口との結合や可視操作の受入は別である。

The Web adapter webSupportReceiptApi uses the existing authFetch cookie/CSRF path. A non-UI Node host executes that actual transport against the isolated receipt HTTP route, maintaining a cookie jar only in the test host. It covers same-request replay, other-owner 404, CSRF rejection, pre-abort with no request, uncertain POST without automatic replay, and revoked session 401. This does not add a visible support screen, deliver mail, prove a browser cookie implementation, or enroll a production operator. An unused adapter may be removed from the Web bundle until an approved consumer is connected.

Web receipt factories bind an expected authenticated owner ID. X-PassShare-Receipt-Owner is an equality precondition checked against the current cookie-authenticated user, never an authorization grant. If cookies switch while CSRF is loading, a mismatched POST is rejected before receipt creation. Other clients may omit this optional precondition and retain their existing authentication contract. The allowed CORS header is explicit. Visible UI remains unconnected.

Authenticated CSRF issuance is stable per live session, derived with a domain-separated HMAC using the existing opaque session credential. It exposes neither that credential nor the session ID and is consistent across router instances. Unauthenticated CSRF issuance remains random; cookie/header equality and session validation are unchanged. Concurrent authenticated receipt requests therefore do not rotate each other's CSRF cookie.

A Web receipt factory also requires a current-session predicate and exposes dispose. Callers dispose on logout/account-lifetime change. Its cancellation remains active through response body completion, so a disposed factory cannot publish a late receipt or start another request. The expected-owner server precondition and session lifetime serve different boundaries.

AuthSessionProvider exposes supportClient for the confirmed account. Logout,
login and signup invalidate that client before awaiting authentication I/O;
account changes, confirmed authorization rejection and Provider unmount also
dispose it. A same-account metadata refresh preserves the current client.
Background refresh cannot acquire another account client while login, signup or
logout owns an outstanding authentication transition. Only that transition's
matching generation releases the refresh exclusion, including on failure.
A receipt response with HTTP 401 retires that factory and clears only its
matching Provider generation. A subsequently confirmed same-owner session gets
a new factory; the old reference cannot follow a replacement cookie. Other
HTTP failures retain their existing error semantics.
The Connect response includes sessionBinding, the existing session-derived CSRF
projection already available to Web callers. It is an equality marker, not an
authentication credential. It remains stable for one cookie session and changes
for another session, even for the same owner. Receipt lifetime follows this
marker, not the independently rotating Connect access token. Existing Connect
response fields and bearer authorization are unchanged.
Provider factories send this marker as X-PassShare-Receipt-Session. The server
compares it with the currently authenticated cookie session before handling a
receipt. A same-owner cookie change before this tab refreshes is therefore
rejected as 401 and retires the stale factory. It grants no access; existing
clients omitting this optional precondition retain normal session authorization.
If an older backend omits sessionBinding, the Provider disables only its receipt
factory. Existing Connect access remains available during deployment ordering.
Consumers must treat a null supportClient as unavailable and obtain a newly
confirmed client through refresh; a retired client is never automatically retried.
Controlled React Provider tests execute the real receipt adapter with synthetic
HTTP responses. They do not prove browser cookies, PostgreSQL persistence or a
visible support operation. The visible entry still requires its scoped UI answer.
