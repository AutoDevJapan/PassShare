## Spec Index（SSOT / トレーサビリティ台帳）

このページは「仕様 → 実装 → テスト」を結びつける **台帳（SSOT）** です。
原則として、**実装が存在するのにSpecが無い**、または **Specがあるのにテスト/検証が無い** 状態を放置しません。

### 現状サマリ
- **PassShare**: gopass互換パスワードマネージャーの仕様を作成済み
- 新規機能を実装する際は、Specを先に作成してから実装に着手する

---

## PassShare（チーム向けパスワードマネージャー）

**株式会社BM1314** の製品としてリリースするパスワードマネージャー。Python/TypeScript/Node.jsの3実装を提供。
pass/gopass形式と互換性があり、既存ストアをそのまま利用可能。

![PassShare Logo](/logo.png)

| Spec | パス | 説明 |
|------|------|------|
| README | `documents/spec/passshare/README.md` | 概要・アーキテクチャ |
| CLI仕様 | `documents/spec/passshare/cli.md` | 全コマンド・オプション |
| 機能仕様 | `documents/spec/passshare/features.md` | 機能の詳細仕様 |
| ストレージ仕様 | `documents/spec/passshare/storage.md` | ストレージバックエンド |
| 暗号化仕様 | `documents/spec/passshare/crypto.md` | 暗号化バックエンド |
| 設定仕様 | `documents/spec/passshare/config.md` | 設定ファイル |
| API仕様 | `documents/spec/passshare/api.md` | プログラマティックAPI |

### トレーサビリティ（PassShare）

| 対象 | Spec（正本） | 実装（主な場所） | テスト/検証 | 状態 |
|------|-------------|-----------------|-------------|------|
| Python実装 | `documents/spec/passshare/` | `packages/passshare-python/` | pytest | 🔲 未実装 |
| TypeScript実装 | `documents/spec/passshare/` | `packages/passshare-ts/` | vitest | 🔲 未実装 |
| Node.js実装 | `documents/spec/passshare/` | `packages/passshare-node/` | jest | 🔲 未実装 |

---

### トレーサビリティ（最小）
| 対象 | Spec（正本） | 実装（主な場所） | テスト/検証（正本コマンド） | 状態 |
|---|---|---|---|---|
| 文書の記述方針（AI最適化） | `documents/spec/writing-guidelines.md` | `documents/spec/*` | 手動レビュー | ✅ |
| ローカル品質ゲート | （なし） | `scripts/quality-gate.mjs` / `scripts/preflight.mjs` | `pnpm quality-gate` / `pnpm preflight` | ✅ |

### テンプレート一覧
- API仕様テンプレ: `documents/spec/api-template.md`
- UI仕様テンプレ: `documents/spec/ui-template.md`
- DB仕様テンプレ: `documents/spec/db-template.md`
- Feature仕様テンプレ: `documents/spec/feature-template.md`
- Usecase仕様テンプレ: `documents/spec/usecase-template.md`
- エラーコード仕様テンプレ: `documents/spec/error-codes-template.md`

### 運用テンプレート
- `documents/templates/`（影響分析/テスト計画/ADR/PR/リリースノート）

### 次に作るべきSpec（推奨順）
1. **プロダクト固有のFeature Spec**（実装する機能に応じて作成）
2. **API Spec**（各APIエンドポイントの仕様）
3. **UI Spec**（画面ごとの仕様）
