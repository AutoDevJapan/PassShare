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

CSRF protection for state-changing Web requests: Issue [#44](https://github.com/AutoDevJapan/PassShare/issues/44).

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
