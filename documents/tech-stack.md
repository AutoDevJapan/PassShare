## 技術スタック（SSOT）
このドキュメントは、本リポジトリの「現状の技術スタック」を **事実ベース**で列挙します。

## デプロイ/インフラ構成

| レイヤー | サービス | 備考 |
|----------|----------|------|
| フロントエンド | **Vercel** | Web配信、CDN |
| バックエンド | **Railway** | FastAPI、自動スケール |
| データベース | **Railway PostgreSQL** | PostgreSQL 16 |
| 課金基盤 | **Stripe** | 将来対応（今回未使用） |

## 対応プラットフォーム

| プラットフォーム | 技術 | 優先順位 |
|------------------|------|----------|
| Web（PC/Tablet/Smartphone） | React + Vite | 1️⃣ 最優先 |
| デスクトップ（Windows/Mac） | Electron | 2️⃣ |
| モバイル（iOS/Android） | Capacitor | 3️⃣ |

## コード共有戦略
**最大共有**: 1つのReactコードベースをWeb/Electron/Capacitorで共有

```
frontend/
├── src/                    # 共通Reactコード
├── electron/               # Electron固有
├── capacitor.config.ts     # Capacitor設定
├── ios/                    # iOS（Capacitor生成）
└── android/                # Android（Capacitor生成）
```

## モノレポ構成
- **パッケージ**: `packages/`（PassShare Python/TypeScript/Node.js実装）
- **フロントエンド**: `frontend/`（React + Vite + Electron + Capacitor）
- **バックエンドAPI**: `backend/`（FastAPI + PostgreSQL）

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
- React 18
- TypeScript
- Vite
- pnpm（パッケージマネージャ）

### UI/スタイリング
- Tailwind CSS
- lucide-react（アイコン）
- clsx（クラス結合）

### ルーティング/通信
- react-router-dom（ルーティング）
- axios（HTTP）

### デスクトップ（Electron）
- electron
- electron-builder（ビルド/配布）
- electron-is-dev（開発/本番判定）

### モバイル（Capacitor）
- @capacitor/core
- @capacitor/cli
- @capacitor/ios
- @capacitor/android

### デプロイ
- Vercel（`vercel.json`）

### 設定ファイル
- `frontend/package.json`
- `frontend/tsconfig.json`
- `frontend/vite.config.ts`
- `frontend/vercel.json`
- `frontend/capacitor.config.ts`
- `frontend/electron/`

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
- **PostgreSQL 16**（Railway PostgreSQL / ローカル: Docker）
- SQLAlchemy 2.0（asyncio + asyncpg）
- Alembic

### テスト
- pytest / pytest-asyncio / pytest-cov

### デプロイ
- Railway（`railway.json`）

### DDDレイヤ
- Presentation: `backend/app/presentation/`
- Domain: `backend/app/domain/`
- Infrastructure: `backend/app/infrastructure/`

### 設定ファイル
- `backend/pyproject.toml`
- `backend/alembic.ini`
- `backend/railway.json`

## ドキュメント運用（SSOT）
- 仕様（Spec）: `documents/spec/`
- 運用テンプレ: `documents/templates/`
- エージェント運用: `AGENTS.md`
