# PassShare Share（チーム共有）

> Issue [#100](https://github.com/AutoDevJapan/PassShare/issues/100)  
> ADR: [004-auth-authorization-model.md](../adr/004-auth-authorization-model.md)

## 概要

パスワードボックス（Connect Vault）を他の PassShare アカウントと共有する。共有先は Connect API 経由で項目の閲覧・編集が可能（`member` ロール）。

## ロール

| ロール | 権限 |
|--------|------|
| `owner` | メンバー招待・削除、ロール変更、ボックス削除（将来） |
| `member` | Connect API 経由の項目 CRUD（`/v1` スコープ内） |

`viewer` は v2.1 以降。

## API（`/api/auth`）

### ボックスメンバー（要セッション）

| Method | Path | 権限 | 説明 |
|--------|------|------|------|
| GET | `/vaults/:vaultId/members` | owner / member | メンバー一覧 |
| PATCH | `/vaults/:vaultId/members/:userId` | owner | ロール変更（`member` のみ） |
| DELETE | `/vaults/:vaultId/members/:userId` | owner | メンバー削除 |

### 招待（要セッション + CSRF）

| Method | Path | 権限 | 説明 |
|--------|------|------|------|
| POST | `/vaults/:vaultId/invitations` | owner | `{ email, role?: "member" }` で招待作成 |
| GET | `/vaults/:vaultId/invitations` | owner | pending 招待一覧 |
| DELETE | `/vaults/:vaultId/invitations/:invitationId` | owner | 招待取消 |

### 受信側招待

| Method | Path | 説明 |
|--------|------|------|
| GET | `/invitations` | ログインユーザー宛 pending 一覧 |
| POST | `/invitations/:id/accept` | 承諾 → `vault_memberships` 追加 |
| POST | `/invitations/:id/decline` | 辞退 |

招待 TTL: **7 日**。未登録メール宛の招待は、アカウント作成後に同じメールで `/invitations` に表示される。

## Web UI

| パス | 内容 |
|------|------|
| `/app/vaults/:vaultId/share` | メンバー一覧・招待フォーム・pending 招待 |
| `/app/invitations` | 受信招待の承諾 / 辞退 |

項目画面（`/app/vaults/:vaultId/items`）から「共有」リンクで遷移。

## 受入基準（Issue #100）

```gherkin
Given パスワードボックスの owner
When 他ユーザーのメールで招待する
Then 相手の /app/invitations に pending が表示される

Given 招待を受けた member
When 承諾する
Then Connect API で当該ボックスの項目にアクセスできる

Given owner
When メンバーを削除する
Then 当該ユーザーの Connect トークン再発行後、ボックスにアクセスできない
```

## 参照

- [auth-api.md](./auth-api.md)
- [sync-migration.md](./sync-migration.md)
