## 技術スタック（SSOT）
このドキュメントは、本リポジトリの「現状の技術スタック」を **事実ベース**で列挙します。

## モノレポ構成
- **フロントエンド**: `frontend/`（React + TypeScript + Vite）
- **バックエンドAPI**: `backend/`（FastAPI + MySQL + DDD/クリーンアーキテクチャ）

## フロントエンド（`frontend/`）
### 実行/ビルド
- React
- TypeScript
- Vite
- pnpm（パッケージマネージャ）

### UI/スタイリング
- Tailwind CSS
- Radix UI（アクセシビリティ前提）
- lucide-react（アイコン）

### ルーティング/通信/ユーティリティ
- react-router-dom（ルーティング）
- axios / fetch（HTTP）
- clsx / tailwind-merge（クラス結合）

### 設定（機械が読む）
- `frontend/package.json`
- `frontend/tsconfig.json`
- `frontend/vite.config.ts`

## バックエンド（`backend/`）
### 言語/実行基盤
- Python: `>=3.13`（`backend/pyproject.toml`）
- uv（依存管理/実行）: `uv sync` / `uv run ...`
- Docker: ルート `docker-compose.yml`

### Web/API
- FastAPI
- Uvicorn

### バリデーション/設定
- Pydantic
- pydantic-settings
- python-dotenv

### DB/ORM/マイグレーション
- MySQL（Dockerイメージ）: `mysql:8.0.36`
- SQLAlchemy（asyncio）
- Alembic

### テスト
- pytest / pytest-asyncio / pytest-cov

### DDDレイヤ（実装場所）
- Presentation: `backend/app/presentation/`（FastAPI endpoints + schemas）
- Domain/Usecase/Infrastructure: `backend/app/` 配下

### 設定（機械が読む）
- ルート: `docker-compose.yml`
- バックエンド: `backend/pyproject.toml`

## ドキュメント運用（SSOT）
- 仕様（Spec）: `documents/spec/`
- 運用テンプレ: `documents/templates/`
- エージェント運用: `AGENTS.md` / `.github/agents` / `.github/prompts`
