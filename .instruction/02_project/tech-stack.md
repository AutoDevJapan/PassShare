## 目的
このリポジトリの採用技術（言語/フレームワーク/主要ライブラリ/ツール）を、**実装と運用の前提**として一箇所にまとめる。

## 参照（完全版）
- 人間/エージェントが共有する「できる限り完全な一覧」は `documents/tech-stack.md` を正とする。

## 全体（モノレポ）
- **フロントエンド**: `frontend/`（React + Vite + TypeScript）
- **バックエンド**: `backend/`（FastAPI + MySQL + DDD）

## フロントエンド（`frontend/`）
- **Runtime / Build**
  - Vite
  - React
  - TypeScript
- **UI**
  - Tailwind CSS
  - Radix UI（アクセシビリティ前提）
- **通信**
  - REST + fetch / Axios（`backend` の API を呼ぶ）
- **パッケージ管理**
  - pnpm（`frontend/package.json` の `packageManager` を正とする）

## バックエンド（`backend/`）
- **Web**
  - FastAPI（Presentation層）
- **設計**
  - Clean Architecture / DDD（Domain → Usecase → Infrastructure → Presentation）
- **DB**
  - MySQL
  - SQLAlchemy（async）
  - Alembic（マイグレーション）
- **Python周り**
  - Python 3.13 系（実際のバージョンは `backend/README.md` と `backend/pyproject.toml` を正とする）
  - uv（依存管理/実行）

## 更新ルール
- 依存や運用前提が変わったら、このドキュメントを **先に更新**する（Spec-Driven Development と同じく SSOT を守る）。
