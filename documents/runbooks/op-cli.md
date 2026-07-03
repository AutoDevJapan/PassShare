# op 互換 CLI Runbook

> Issue [#210](https://github.com/AutoDevJapan/PassShare/issues/210)  
> 親 Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205)

## 目的

開発者・運用者が **op 互換 CLI** をビルドし、Connect API に接続して vault / item 操作できるようにする。

## 前提

| ツール | バージョン |
|--------|-----------|
| Rust | stable（`rustup` 推奨） |
| Connect API | ローカル / dev / stg / prd のいずれか |

## ビルド

リポジトリ root から:

```powershell
cargo build -p op-cli --release
```

成果物:

| OS | パス |
|----|------|
| Windows | `target\release\op.exe` |
| Linux / macOS | `target/release/op` |

CI では `op-cli-build.yml` が PR / main push 時に artifact をアップロードする。

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `OP_CONNECT_HOST` | yes | Backend URL（例: `http://127.0.0.1:8080`） |
| `OP_CONNECT_TOKEN` | yes | Connect Bearer トークン |

PowerShell 例（ローカル backend + デフォルト dev トークン）:

```powershell
$env:OP_CONNECT_HOST = "http://127.0.0.1:8080"
$env:OP_CONNECT_TOKEN = "test-connect-token"
.\target\release\op.exe vault list
```

stg 例:

```powershell
$env:OP_CONNECT_HOST = "https://pass-share-backend-staging.up.railway.app"
$env:OP_CONNECT_TOKEN = "<STG_OP_CONNECT_TOKEN>"
op vault list
```

## 代表コマンド

```powershell
# Vault 一覧
op vault list

# Item 作成
op item create --vault "My Password Box" --category LOGIN --title "Example" username=user@example.com password=secret

# Item 一覧 / 取得
op item list --vault "My Password Box"
op item get --vault "My Password Box" --item "<item-id>" --fields password

# op:// 参照（スクリプト連携）
op read "op://My Password Box/Example/password"
```

## 検証

### ローカル（backend dev server）

```powershell
# ターミナル 1: backend
$env:APP_ENV = "local"
$env:PORT = "8080"
node backend/src/index.js

# ターミナル 2: op-cli
cargo build -p op-cli --release
$env:OP_CONNECT_HOST = "http://127.0.0.1:8080"
$env:OP_CONNECT_TOKEN = "test-connect-token"
.\target\release\op.exe vault list
```

### Docker E2E（CI と同じ）

```powershell
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e
```

`backend-e2e` サービスがコンテナ内で op-cli をビルド（`cargo build -p op-cli --release`）してから E2E を実行するため、**このコマンド単体で完結する**（host 側の事前ビルドは不要）。コンテナと同一 glibc でビルドされるので host との不整合も起きない（#320）。`backend/test/op-cli-e2e.test.js` が vault list / item CRUD / `op read` を検証する。

## CI 成果物

- Workflow: `.github/workflows/op-cli-build.yml`
- Artifact 名: `op-cli-<platform>`（ubuntu / windows / macos）
- ダウンロード: GitHub Actions → 対象 run → Artifacts

## 関連

- [operational-readiness.md](../spec/operational-readiness.md)
- [infrastructure.md](../spec/infrastructure.md) — Backend URL SSOT
- [local-dev-web.md](./local-dev-web.md) — Web + backend ローカル起動
