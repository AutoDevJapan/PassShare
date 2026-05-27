# PassShare MVP 機能仕様 (SSOT)

> 最終更新: 2026-05-27  
> 本番完全版: [production-v2.md](./production-v2.md)（v2.0 / Epic #28）

## 概要

PassShare は非 IT エンジニア向けのパスワードマネージャー。Rust で暗号化コアを実装し、Tauri v2 + React デスクトップアプリで操作する。

## ユーザー向け用語（MUST）

| 内部概念 | UI 表示 | 使用禁止 |
|----------|---------|----------|
| PasswordBox | **パスワードボックス** | 金庫、Vault、ボルト |
| Master Password | **マスターパスワード** | マスターキー |
| Login Item | **ログイン情報** | クレデンシャル |
| Unlock | **開く** | 解錠、Unlock |
| Lock | **閉じる** | ロック |

## スコープ

### v0.1（本イテレーション）

- マスターパスワードでパスワードボックスを開く / 閉じる
- ログイン情報の CRUD
- パスワード自動生成
- タイトル / URL / ユーザー名での検索
- ローカル暗号化ファイル保存（ゼロナレッジ）
- 緊急キット（リカバリ用シークレットキー表示）

### v0.2 以降

- Tauri UI 完成（クリップボード自動消去）
- ファイル同期（iCloud / Dropbox 等）
- 共有機能（PassShare の Share）

## アーキテクチャ

```
apps/desktop (Tauri v2 + React)     frontend/ (Web ランディング)
    ↓ invoke                            ↓ (将来: ConnectClient)
crates/passshare-core               packages/connect-js
    ├── crypto                          backend/ (Connect API /v1)
    ├── domain (Vault, Item, Field)
    └── storage (.pbox)
crates/passshare-connect + op-cli   packages/connect-python, connect-go
```

## 暗号仕様

| 項目 | 方式 |
|------|------|
| KDF | Argon2id (m=64MiB, t=3, p=4) |
| 暗号化 | XChaCha20-Poly1305 |
| 乱数 | OS CSPRNG (`getrandom`) |
| 秘密情報 | `zeroize` でメモリ消去 |

### v1（1Password Connect 互換 — Epic #9）✅ 完了

- Vault / Item / Field ドメインモデル（Connect スキーマ準拠）
- ペイロード version 2（`.pbox` 暗号ラッパー version は 1 のまま）
- v0.1 LoginItem → Item マイグレーション（open 時自動）
- 1Password CSV インポート
- Connect API REST（`backend/`）、`op` CLI + SDK 4 言語、Desktop category UI
- 詳細: [1Password Connect 互換仕様](./1password-connect-compatibility.md)

## データモデル

> v1 以降の SSOT は [1Password Connect 互換仕様](./1password-connect-compatibility.md)。以下は v0.1 レガシー参考。

### LoginItem（v0.1 レガシー）

| フィールド | 型 | 必須 |
|-----------|-----|------|
| id | UUID | yes |
| title | string | yes |
| url | string | no |
| username | string | no |
| password | string | yes |
| notes | string | no |
| created_at | ISO8601 | yes |
| updated_at | ISO8601 | yes |

### PasswordBoxFile（ディスク上）

```json
{
  "version": 1,
  "kdf": { "algorithm": "argon2id", "salt": "base64", "params": {} },
  "cipher": { "algorithm": "xchacha20poly1305", "nonce": "base64" },
  "ciphertext": "base64"
}
```

平文ペイロード（暗号化前）:

```json
{
  "items": [ /* LoginItem[] */ ],
  "recovery_hint": "optional string"
}
```

## 受入基準 (ATDD)

```gherkin
Given 初回起動でマスターパスワードを設定した
When  ログイン情報を1件追加する
Then  暗号化ファイルに保存され、同じマスターパスワードで開ける

Given パスワードボックスが開いている
When  16文字・記号込みのパスワードを生成する
Then  推測困難な文字列が返る

Given 間違ったマスターパスワードを入力した
When  パスワードボックスを開こうとする
Then  エラーが返り、中身は読めない

Given パスワードボックスが開いている
When  タイトルで検索する
Then  一致するログイン情報のみ返る
```

## エラーコード

| コード | ユーザー向けメッセージ |
|--------|------------------------|
| `PS001` | マスターパスワードが正しくありません |
| `PS002` | パスワードボックスファイルが見つかりません |
| `PS003` | ファイルが壊れているか、別のパスワードボックスです |
| `PS004` | タイトルは必須です |
| `PS005` | パスワードは必須です |
| `PS009` | ID 形式が正しくありません |
| `PS010` | インポートに失敗しました |

## 完了条件

- [x] `passshare-core` 単体テストが Docker 上で全 pass
- [x] Spec と実装が一致
- [x] README にセットアップ手順記載
- [x] Tauri スケルトンがビルド可能（`apps/desktop/src-tauri` 構成済み）
