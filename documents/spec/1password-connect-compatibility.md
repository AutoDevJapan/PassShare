# PassShare 1Password Connect 互換仕様 (SSOT)

> 最終更新: 2026-05-27  
> ADR: [002-1password-connect-compatibility](../adr/002-1password-connect-compatibility.md)

## 概要

PassShare は **1Password Connect API / `op` CLI / 公式 SDK 互換** を外部インターフェースの SSOT とする。
暗号・ストレージエンジンは PassShare 独自（Argon2id + XChaCha20-Poly1305）を維持する。

参照: [1Password Connect API Reference](https://www.1password.dev/connect/api-reference)

## 用語（二層）

| 1Password / API | PassShare 内部 | UI 表示（MUST） |
|-----------------|---------------|----------------|
| Vault | `Vault` | **パスワードボックス** |
| Item | `Item` | category 別（ログイン情報 等） |
| Master Password | `MasterPassword` | **マスターパスワード** |
| Unlock / Lock | `Unlock` / `Lock` | **開く** / **閉じる** |

UI・エラーメッセージで **Vault / 金庫 / ボルト** は使用禁止。

---

## Phase 1: データモデル

### ID 形式

- Vault ID / Item ID / Field ID: **26 文字 lowercase alphanumeric**（`^[a-z0-9]{26}$`）
- 1Password Connect と同一形式
- 既存 UUID v4 `LoginItem` はマイグレーション時に再採番

### Vault

Connect API `Vault` オブジェクトに準拠。

| フィールド | 型 | 備考 |
|-----------|-----|------|
| id | string(26) | readOnly |
| name | string | UI ではパスワードボックス名 |
| description | string | optional |
| type | enum | `USER_CREATED`, `PERSONAL`, `EVERYONE`, `TRANSFER` |
| items | integer | readOnly, アイテム数 |
| createdAt | ISO8601 | readOnly |
| updatedAt | ISO8601 | readOnly |
| contentVersion | integer | 楽観的ロック |
| attributeVersion | integer | メタデータ版 |

**ローカル永続化:** 1 Vault = 1 `.pbox` ファイル（暗号化ペイロード内に Vault メタ + Items）。

### Item

Connect API `Item` オブジェクトに準拠。

| フィールド | 型 | 備考 |
|-----------|-----|------|
| id | string(26) | readOnly |
| title | string | |
| category | enum | 下表 |
| vault | VaultReference | `{ id }` |
| fields | Field[] | |
| sections | Section[] | optional |
| urls | Url[] | `{ label, primary, href }` |
| tags | string[] | |
| favorite | boolean | default false |
| createdAt | ISO8601 | readOnly |
| updatedAt | ISO8601 | readOnly |
| lastEditedBy | string | readOnly, optional |

#### category（MVP 対象）

| category | UI 表示 | 備考 |
|----------|---------|------|
| `LOGIN` | ログイン情報 | 旧 LoginItem 相当 |
| `PASSWORD` | パスワード | |
| `SECURE_NOTE` | セキュアメモ | |
| `CREDIT_CARD` | クレジットカード | v0.3 |
| `IDENTITY` | 個人情報 | v0.3 |
| `SSH_KEY` | SSH キー | v0.3 |
| `CUSTOM` | カスタム | v0.3 |

### Field

| フィールド | 型 | 備考 |
|-----------|-----|------|
| id | string(26) | |
| label | string | |
| type | enum | `STRING`, `CONCEALED`, `EMAIL`, `URL`, `OTP`, ... |
| purpose | enum | `USERNAME`, `PASSWORD`, `NOTES`, null |
| value | string | |
| section | SectionReference | optional |
| entropy | number | 生成パスワード時 |
| passwordDetails | object | strength, history 等 |

**LOGIN デフォルト fields:**

- `purpose: USERNAME` — ユーザー名
- `purpose: PASSWORD` — パスワード（CONCEALED）
- `label: notes`, `type: STRING` — メモ

### 暗号化ペイロード（PassShare 独自・内部）

```json
{
  "vault": { "id": "...", "name": "...", "contentVersion": 1 },
  "items": [ /* Item[] */ ],
  "recoverySecret": "optional"
}
```

`.pbox` ファイルラッパー（KDF + cipher）は [MVP 暗号仕様](./feature-passshare-mvp.md) を維持。

### マイグレーション（v0.1 → v1）

```
LoginItem (UUID) → Item (category: LOGIN, 26-char id)
PasswordBox      → Vault (1:1)
url string       → urls[{ href, primary: true }]
username         → field purpose USERNAME
password         → field purpose PASSWORD
notes            → field label notes
```

### インポート

| 形式 | 優先度 | 備考 |
|------|--------|------|
| 1Password CSV | P0 | 列マッピング表を別途定義 |
| 1PUX | P1 | ZIP + JSON、1Password export |
| Bitwarden JSON | P2 | 参照 UI Migration セクション |

---

## Phase 2: Connect API

Base URL: `{CONNECT_SERVER}/v1`  
認証: `Authorization: Bearer {token}`（Connect JWT 互換）

### エンドポイント（必須）

| Method | Path | 説明 |
|--------|------|------|
| GET | `/vaults` | Vault 一覧 |
| GET | `/vaults/{vaultUuid}` | Vault 詳細 |
| GET | `/vaults/{vaultUuid}/items` | Item 一覧（概要） |
| POST | `/vaults/{vaultUuid}/items` | Item 作成 |
| GET | `/vaults/{vaultUuid}/items/{itemUuid}` | Item 詳細 |
| PUT | `/vaults/{vaultUuid}/items/{itemUuid}` | Item 全置換 |
| PATCH | `/vaults/{vaultUuid}/items/{itemUuid}` | JSON Patch 部分更新 |
| DELETE | `/vaults/{vaultUuid}/items/{itemUuid}` | Item 削除 |
| GET | `/vaults/{vaultUuid}/items/{itemUuid}/files/{fileUuid}` | ファイルメタ |
| GET | `/vaults/{vaultUuid}/items/{itemUuid}/files/{fileUuid}/content` | ファイル本体 |

### JSON Patch 例

```json
[
  { "op": "replace", "path": "/fields/1/value", "value": "new-password" }
]
```

### OpenAPI

- SSOT: `documents/spec/openapi/connect-api.yaml`（Connect API fork + PassShare extensions）
- 差分は `x-passshare-*` 拡張フィールドで明示

### エラー

Connect 形式 `{ "status": 404, "message": "..." }` + PassShare コード `PS001`〜を message 内または header で付与。

### デプロイ

Railway `pass-share-backend` が Connect Server 互換 API を提供（[infrastructure](./infrastructure.md)）。

**実装（Phase 2）:** `backend/src/connect/` — Express `/v1` ルーター、PostgreSQL 永続化、`OP_CONNECT_TOKEN` Bearer 認証。

### エラーコード（Connect API 追加分）

| コード | 意味 |
|--------|------|
| PS011 | Bearer トークン無効 |
| PS012 | Vault / リソース未検出 |
| PS013 | JSON Patch 不正 |
| PS014 | ファイル未検出 |
| PS015 | PATCH Content-Type 不正 |

---

## Phase 3: CLI / SDK

### `op` 互換 CLI

バイナリ名: `op`（または `passshare op` エイリアス）

| コマンド | 互換 |
|---------|------|
| `op vault list` | ✓ |
| `op item list --vault {name}` | ✓ |
| `op item get {item} --fields password` | ✓ |
| `op read op://{vault}/{item}/{field}` | ✓ |
| `op item create --category login ...` | ✓ |
| `op item edit {item}` | ✓ |
| `op item delete {item}` | ✓ |

環境変数: `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`（1Password 互換）

### 実装（Phase 3）

| コンポーネント | パス |
|---------------|------|
| Rust SDK | `crates/passshare-connect/` |
| `op` CLI | `crates/op-cli/`（バイナリ名 `op`） |
| TypeScript SDK | `packages/connect-js/`（`@passshare/connect`） |
| Python SDK | `packages/connect-python/` |
| Go SDK | `packages/connect-go/` |

環境変数: `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`（1Password 互換）

### シークレット参照

```
op://{vault}/{item}/{field}
op://{vault}/{item}/password
```

### SDK

| 言語 | パッケージ | 方針 |
|------|-----------|------|
| **TypeScript / Node** | `@passshare/connect` | Connect API 互換、型は手書き（OpenAPI 生成は後続） |
| **Python** | `passshare-connect` | `onepasswordconnectsdk` 互換 API |
| **Go** | `github.com/autodevjapan/passshare-connect` | 公式 Connect Go SDK 互換 |
| **Rust** | `passshare-connect` crate | `passshare-core` + HTTP クライアント |

SDK は Connect API の薄いラッパー。暗号操作は Rust core 経由（FFI / ローカル `.pbox`）。

---

## Phase 4: UI

- 参照: https://pass-share.bm1314.net/
- category 別 Item 編集フォーム（1Password テンプレート準拠）
- 既存 UI Issues: #3–#8

---

## 受入基準（Phase 別）

### Phase 1

```gherkin
Given 1Password CSV をインポートした
When  パスワードボックスを開く
Then  LOGIN category の Item が Connect スキーマで読める

Given v0.1 の .pbox ファイルがある
When  マイグレーションを実行する
Then  Item id が 26 文字形式になりデータが欠損しない
```

### Phase 2

```gherkin
Given Connect 互換 API が起動している
When  GET /v1/vaults/{id}/items を Bearer トークン付きで呼ぶ
Then  1Password Connect と同形式の JSON が返る

When  PATCH で password field を更新する
Then  JSON Patch 仕様どおり部分更新される
```

### Phase 3

```gherkin
Given op CLI が設定済み
When  op read "op://Work/GitHub/password" を実行する
Then  パスワードが標準出力またはクリップボードに渡る

Given TypeScript SDK
When  client.getItem(vaultId, itemId) を呼ぶ
Then  1Password Connect SDK と同じメソッドシグネチャで動作する
```

---

## 関連ドキュメント

- [MVP 機能仕様](./feature-passshare-mvp.md)
- [インフラ構成](./infrastructure.md)
- [ADR 002](../adr/002-1password-connect-compatibility.md)
