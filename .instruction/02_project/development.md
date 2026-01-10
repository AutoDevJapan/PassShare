## 目的
このモノレポ（Frontend/Backend）の **開発手順** をSSOTとして整理する。
「誰がやっても同じ手順で起動できる」「詰まったら切り分けできる」状態を目標にする。

## スコープ
- **やる**: ローカル起動、主要コマンド、環境変数、よくある詰まりの切り分け
- **やらない**: 本番運用のCI/CD編集（`.github/workflows/` は編集禁止）

## 構成（SSOT）
- `frontend/`: React + Vite + TypeScript（WebUI）
- `backend/`: FastAPI + MySQL（DDD/クリーンアーキテクチャ）

技術スタックの一覧は `.instruction/02_project/tech-stack.md` を正とする。

## ローカル起動（最短）
### 1) Backend + MySQL（Docker）
ルート `docker-compose.yml` を使う（推奨）。

- 起動: `docker compose up -d`
- ログ: `docker compose logs -f api`
- 停止: `docker compose down`

環境変数は `.env`（ルート）で上書きできる。例は `env.example` を参照する。

### 2) Frontend
別ターミナルで実行:

- 依存導入: `pnpm -C frontend install`
- 開発起動: `pnpm -C frontend dev`

## よく使う品質ゲート（最低限）
- フロント変更: `pnpm -C frontend build`
- バック変更: `backend/README.md` の最小起動/疎通

## 環境変数の考え方
- **ルート `docker-compose.yml`**: コンテナ起動時に `.env` を参照する
- **`backend/` ローカル実行**: `backend/.env` を用意して `uv` で読み込む想定（詳細は `backend/README.md`）
- **秘密情報**（APIキー等）はGit管理しない

## トラブルシューティング（最短の切り分け）
- **DBに繋がらない**:
  - `docker compose ps` で mysql が healthy か
  - `docker compose logs mysql` で起動エラーがないか
- **Backendが起動しない**:
  - `docker compose logs api` を確認（環境変数/依存/マイグレーション）
- **Frontendが起動しない**:
  - `pnpm -C frontend build` で型/ビルドが通るか
