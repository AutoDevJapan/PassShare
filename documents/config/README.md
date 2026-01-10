## 設定（yaml/json）カタログ
このリポジトリでは `.yaml/.yml/.json` は機械が読む前提です。
**人間/エージェントが誤解しないために、ここに説明（.md）を集約**します。

## docker-compose（開発用）
- **ルート**: `docker-compose.yml`
  - Backend（FastAPI）+ MySQL をまとめて起動する
  - 参照する環境変数（`.env`）は `documents/setup/environment-variables.md` を参照
- **バックエンド単体**: `backend/docker/compose.yml`
  - `backend` のみを起動/検証したい場合に使う

## Electron配布設定
- `electron/electron-builder.yml`
  - Windows/macOS向け配布（NSIS/DMG）設定

## CI/CD（編集禁止）
> `.github/workflows/` は運用上の理由で **作成/編集/追加は禁止** です（方針の提案や説明は可）。

- `.github/workflows/*.yml`
  - ビルド/デプロイ/terraform apply などの自動化

## ローカル品質ゲート（推奨）
- `pnpm quality-gate`（クロスプラットフォーム / Windows / macOS / Linux 共通）
  - **必須（フロント）**: `pnpm -C electron format:check` / `pnpm -C electron lint` / `pnpm -C electron check-types` / `pnpm -C electron build`
  - **必須**: `uv run ruff check`（backend/agent）
  - **必須**: `uv run pytest -q`（backendのAPIスモークテスト）
  - 依存の再インストールを省略したい場合: `pnpm quality-gate --skip-install`
  - 短縮形: `pnpm qg`

## 外部ツール（別レポ）統合
- 外部ツールは `vendor/` 配下に配置し、**起動コマンドは宣言的に管理**します。
- 正本マニフェスト: `documents/config/external-tools.json`
- 実行（Windows）: `python .\\scripts\\run_external_tools.py`
- 実行（macOS/WSL）: `python ./scripts/run_external_tools.py`

## E2E（Playwright）
> NOTE: 現状は未整備です（追加したら `documents/spec/index.md` と `documents/spec/features/dev-environment-tooling.md` を更新してください）

## MCP（Cursor前提）
- 正本: `documents/config/mcp.md`
- テンプレ: `documents/config/cursor-mcp.template.json`（各自 `~/.cursor/mcp.json` にコピーして利用）

## SSOT ⇔ Google Sheets 同期
- **目的**: クライアント/PMがGoogle Sheetsで仕様・課題を編集でき、開発者のMarkdown SSOTと自動同期
- **設定**: `scripts/ssot/sync_config.yaml`
- **セットアップ手順**: `scripts/ssot/README.md`
- **Feature Spec**: `documents/spec/features/ssot-sheets-sync.md`
- **GitHub Actions**: `.github/workflows/ssot-sync.yml`
- **環境変数**:
  - `SSOT_SPREADSHEET_ID`: Google SheetsのスプレッドシートID
  - `GOOGLE_SERVICE_ACCOUNT_KEY`: サービスアカウントJSONキーのパス
- **ローカル実行**:
  - `python scripts/ssot/sync_to_sheets.py --dry-run`
  - `python scripts/ssot/sync_from_sheets.py --dry-run`

## JSON（宣言/定義）
- `backend/step_definitions.json`
  - ステップ定義の一覧（生成/参照用）
- `electron/components.json`
  - UIコンポーネントの設定（shadcn/ui方式）
- `electron/package.json`
  - フロントの依存/スクリプト
- `electron/tsconfig*.json`
  - TypeScript設定


