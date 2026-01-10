## Spec Index（SSOT / トレーサビリティ台帳）

このページは「仕様 → 実装 → テスト」を結びつける **台帳（SSOT）** です。
原則として、**実装が存在するのにSpecが無い**、または **Specがあるのにテスト/検証が無い** 状態を放置しません。

### 現状サマリ
- **Specがテンプレのみ**で、実プロダクト仕様（Feature/UI/API/Usecase）が未作成
- 新規機能を実装する際は、Specを先に作成してから実装に着手する

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
