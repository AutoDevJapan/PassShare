# Auth API Specification

Status: Implemented (Issue [#42](https://github.com/AutoDevJapan/PassShare/issues/42))  
SSOT for L1 account authentication. Authorization model: [ADR 004](../adr/004-auth-authorization-model.md).

## Overview

PassShare account authentication uses Email + Password. Successful login issues an HttpOnly session cookie for Web clients. Authenticated sessions can mint short-lived Connect access tokens for `/v1/*` (L2).

Account password and master password (local `.pbox` decryption) are separate concepts.

## Base Path

`/api/auth`

## Endpoints

### POST `/signup`

Create a user account, default password box, and session.

**Request body**

```json
{
  "email": "user@example.com",
  "password": "minimum-8-chars"
}
```

**Response `201`**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "createdAt": "2026-05-27T00:00:00.000Z"
  },
  "sessionExpiresAt": "2026-06-03T00:00:00.000Z"
}
```

**Headers:** `Set-Cookie: passshare_session=...; HttpOnly; Path=/; SameSite=Lax`

**Errors**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | PS020 | Invalid email |
| 400 | PS021 | Password too short |
| 409 | PS023 | Email already registered |

Side effects:

1. Insert `users` row (Argon2id password hash)
2. Create default password box in `connect_vaults`
3. Insert `vault_memberships` (`owner`)
4. Insert `sessions` row

### POST `/login`

Verify credentials and issue a session.

**Request body:** same as signup

**Response `200`:** same shape as signup (without `201`)

**Errors**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | PS020 / PS021 | Validation failure |
| 401 | PS026 | Invalid email or password |
| 429 | PS028 | Account temporarily locked (too many failed logins) |
| 429 | PS029 | IP rate limit exceeded |

### Brute-force protection (Issue [#45](https://github.com/AutoDevJapan/PassShare/issues/45))

| Policy | Value |
|--------|-------|
| Failed login threshold | 5 consecutive failures per email |
| Lockout duration | 15 minutes |
| IP window | 30 requests / 15 minutes per IP on `/login` |
| Response | `429` with `Retry-After` header |

### POST `/logout`

Delete the current session.

**Auth:** session cookie required

**Response:** `204 No Content`  
**Headers:** clears `passshare_session` cookie

### POST `/refresh`

Extend the current session expiry (sliding window).

**Auth:** session cookie required

**Response `200`**

```json
{
  "sessionExpiresAt": "2026-06-03T00:00:00.000Z"
}
```

### GET `/me`

Return the authenticated user.

**Auth:** session cookie required

**Response `200`**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "createdAt": "2026-05-27T00:00:00.000Z"
  }
}
```

### GET `/csrf`

Issue a CSRF token for double-submit validation.

**Auth:** none

**Response `200`**

```json
{
  "csrfToken": "base64url-token"
}
```

**Headers:** sets `passshare_csrf` cookie (not HttpOnly).

### GET `/connect-token`

Mint a Connect API bearer token scoped to the user's password boxes.

**Auth:** session cookie required

**Response `200`**

```json
{
  "accessToken": "base64url-token",
  "expiresIn": 900,
  "expiresAt": "2026-05-27T00:15:00.000Z"
}
```

Token is stored hashed in `connect_tokens`. Plaintext is returned once. `/v1` middleware resolves the bearer token via `connect_tokens` and scopes vault access to `vault_ids` (Issue [#43](https://github.com/AutoDevJapan/PassShare/issues/43)).

**Legacy (local/dev/stg only):** `OP_CONNECT_TOKEN` remains as a deprecated fallback for CLI/SDK migration. Disabled in `prd`.

## Session Cookie

| Attribute | Value |
|-----------|-------|
| Name | `passshare_session` |
| HttpOnly | yes |
| SameSite | Lax |
| Secure | yes in `prd` / `stg` |
| TTL | 7 days (sliding on `/refresh`) |

CSRF protection for state-changing Web requests (Issue [#44](https://github.com/AutoDevJapan/PassShare/issues/44)):

| Item | Value |
|------|-------|
| Cookie | `passshare_csrf` (readable by JS, **not** HttpOnly) |
| Header | `X-CSRF-Token` must match cookie (double-submit) |
| Protected routes | `POST /signup`, `/login`, `/logout`, `/refresh` |
| Bootstrap | `GET /api/auth/csrf` before first state-changing call |

**Errors:** `403 PS027` when CSRF validation fails.

**Web CORS:** `WEB_ORIGIN` env (default `http://localhost:5173`) with `Access-Control-Allow-Credentials: true`.

Frontend uses `credentials: "include"` via `frontend/src/lib/auth-api.ts` and `AuthSessionProvider`.

## Acceptance Criteria (Issue #44)

```gherkin
Given a Web client
When the user logs in
Then the session cookie is HttpOnly

Given a POST without CSRF token
When the auth API is called
Then the response status is 403

Given an authenticated session
When the user logs out
Then the session is invalidated
```

## Database Tables

Defined in `backend/src/db/auth-schema.js`:

- `users`
- `sessions`
- `connect_tokens`
- `vault_memberships` (FK → `connect_vaults`)

Connect vault schema remains in `backend/src/db/schema.js`.

## Acceptance Criteria (Issue #42)

```gherkin
Given valid credentials
When the user logs in
Then a session cookie is issued

Given an invalid password
When the user logs in
Then the response status is 401
```

## References

- [ADR 004: Auth & Authorization](../adr/004-auth-authorization-model.md)
- [production-v2.md](./production-v2.md)
