# ADR 002: 1Password Connect 互換を採用する

## Status

Accepted (2026-05-27)

## Context

PassShare は非 IT 向けパスワードマネージャーとして MVP（ローカル暗号化 + Tauri）を実装済みである。
今後、チーム共有・自動化・マルチクライアント（Web / Desktop / CLI / SDK）を提供するにあたり、
独自 API をゼロから設計するとエコシステム構築コストが高い。

1Password は以下を業界 de facto として確立している。

- **Connect API** — Vault / Item の REST CRUD（[API Reference](https://www.1password.dev/connect/api-reference)）
- **`op` CLI** — `op item list`, `op read op://vault/item/field`
- **公式 SDK** — Go / Python / JavaScript 等
- **Item モデル** — category, fields, sections, tags, JSON Patch 更新

参照 UI（https://pass-share.bm1314.net/）も CLI / SDK / チーム共有を訴求しており、
PassShare のプロダクト方向と一致する。

## Decision

PassShare は **インターフェース層を 1Password Connect / `op` に準拠** させる。

| レイヤー | 方針 |
|---------|------|
| **データモデル** | 1Password `Vault` / `Item` / `Field` / `Section` スキーマに合わせる |
| **REST API** | Connect API エンドポイント・リクエスト / レスポンス・JSON Patch を互換実装 |
| **CLI** | `op` 互換サブコマンド + `op://` シークレット参照 |
| **SDK** | Connect API クライアント互換（TypeScript, Python, Go, Rust） |
| **インポート** | 1Password CSV / 1PUX からの移行をサポート |

### 揃えない部分（PassShare 独自）

| 項目 | 理由 |
|------|------|
| **暗号** | Argon2id + XChaCha20-Poly1305 を維持（ゼロナレッジ・ローカルファースト） |
| **ホスティング** | 1Password.com 非依存。Connect Server 互換 API を Railway 等で自己ホスト |
| **UI 用語** | ユーザー向けは **パスワードボックス**（Vault / 金庫 / ボルトは UI 禁止） |

### 内部 ↔ 1Password マッピング

| 1Password | PassShare 内部 | UI 表示 |
|-----------|---------------|---------|
| Vault | `Vault` / `PasswordBox` | パスワードボックス |
| Item | `Item` | ログイン情報 等（category 別） |
| Field | `Field` | フィールドラベル |
| `op://` reference | `OpReference` | （CLI / SDK のみ） |

## Consequences

### Positive

- 既存 1Password SDK / ツールチェーンを最小変更で利用可能
- `op` 互換により CI/CD・インフラ自動化が容易
- 1Password からの移行パスが明確（CSV / 1PUX）
- OpenAPI を SSOT にでき、SDK 自動生成が可能

### Negative

- `LoginItem` / UUID v4 モデルの breaking change
- Connect API 全エンドポイント実装の工数
- 1Password 仕様追従のメンテナンスコスト
- UI 用語と API 用語（vault）の二層管理が必要

### Migration

1. **Phase 1** — ドメインモデル移行（Item, Vault, 26-char ID）、1PUX インポート
2. **Phase 2** — Connect API 互換 REST + Bearer 認証
3. **Phase 3** — `op` CLI + SDK（TS / Python / Go / Rust）
4. **Phase 4** — UI（参照サイトデザイン + 1Password カテゴリ）

既存 v0.1 `.pbox` ファイルはマイグレーションスクリプトで Item モデルへ変換する。

## Alternatives Considered

| 代替案 | 不採用理由 |
|--------|-----------|
| 独自 REST API | SDK / CLI / 移行ツールをすべて自前開発する必要 |
| Bitwarden 互換 | 参照 UI・CLI 訴求が 1Password / pass 系。チーム共有 UX も 1Password 寄り |
| 1Password 完全クローン（暗号含む） | 実装不可・ライセンス / セキュリティ監査の観点から非現実的 |
| API のみ互換・モデルは独自 | SDK 互換が崩れ、Connect クライアントがそのまま使えない |

## References

- [1Password Connect API Reference](https://www.1password.dev/connect/api-reference)
- [PassShare 1Password 互換仕様](../spec/1password-connect-compatibility.md)
- [MVP 機能仕様](../spec/feature-passshare-mvp.md)
- ADR 001: Vercel + Railway 4 環境構成
