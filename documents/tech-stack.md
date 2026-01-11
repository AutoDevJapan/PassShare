## 技術スタック（SSOT）
このドキュメントは、本リポジトリの「現状の技術スタック」を **事実ベース**で列挙します。

## モノレポ構成
- **パッケージ**: `packages/`（PassShare Python/TypeScript/Node.js実装）
- **フロントエンド**: `frontend/`（React + TypeScript + Vite）
- **バックエンドAPI**: `backend/`（FastAPI + PostgreSQL + DDD/クリーンアーキテクチャ）

## パッケージ（`packages/`）

### passshare-python
- Python 3.11+
- CLI: click
- OTP: pyotp
- クリップボード: pyperclip
- 配布: PyPI

### passshare-ts
- TypeScript
- ESM + CommonJS デュアルビルド
- 配布: npm

### passshare-node
- Node.js 18+
- CLI: commander.js
- カラー出力: chalk
- 配布: npm

## フロントエンド（`frontend/`）
### 実行/ビルド
- React
- TypeScript
- Vite
- pnpm（パッケージマネージャ）

### UI/スタイリング
- Tailwind CSS
- lucide-react（アイコン）
- clsx（クラス結合）

### ルーティング/通信/ユーティリティ
- react-router-dom（ルーティング）
- axios（HTTP）

### 設定（機械が読む）
- `frontend/package.json`
- `frontend/tsconfig.json`
- `frontend/vite.config.ts`

## バックエンド（`backend/`）
### 言語/実行基盤
- Python: `>=3.11`（`backend/pyproject.toml`）
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
- **PostgreSQL 16**（Dockerイメージ: `postgres:16-alpine`）
- SQLAlchemy 2.0（asyncio + asyncpg）
- Alembic

### テスト
- pytest / pytest-asyncio / pytest-cov

### DDDレイヤ（実装場所）
- Presentation: `backend/app/presentation/`（FastAPI endpoints + schemas）
- Domain: `backend/app/domain/`（models）
- Infrastructure: `backend/app/infrastructure/`（database）

### 設定（機械が読む）
- ルート: `docker-compose.yml`
- バックエンド: `backend/pyproject.toml`
- マイグレーション: `backend/alembic.ini`

## ドキュメント運用（SSOT）
- 仕様（Spec）: `documents/spec/`
- 運用テンプレ: `documents/templates/`
- エージェント運用: `AGENTS.md` / `.github/agents` / `.github/prompts`
