# op 互換 CLI Runbook

> Issue [#210](https://github.com/AutoDevJapan/PassShare/issues/210)  
> 親 Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205)

## 目的

開発者・運用者が **op 互換 CLI** をビルドし、パスワードボックスと項目を操作できるようにする。
暗号化したボックスは明示的な `--encrypted` モードを使う。
[CLI の暗号化モード](../spec/encrypted-cli.md) に入力境界、所有者の操作、共有受信者の読取、再送と未対応範囲を記載する。

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
# パスワードボックス一覧
op vault list

# Item 作成
op item create --vault "My Password Box" --category LOGIN --title "Example" username=user@example.com password=secret

# Item 一覧 / 取得
op item list --vault "My Password Box"
op item get "<item-id>" --vault "My Password Box" --fields password

# op:// 参照（スクリプト連携）
op read "op://My Password Box/Example/password"
```

## 検証

### 暗号化モード（所有者）

秘密管理ツールから `sessionToken` と `encryptionPassword` を含むJSONをパイプで渡す。
秘密値をコマンド引数やシェル履歴へ書かない。
接続先は `PASSSHARE_HOST`、ボックスは26文字のIDを指定する。

```powershell
# 左側のパイプ入力は利用者の秘密管理ツールから供給する。
op --encrypted --secret-stdin item list --vault "<box-id>"
op --encrypted --secret-stdin item get "<item-id>" --vault "<box-id>" --fields password
op --encrypted --secret-stdin --prepare-only item create --vault "<box-id>"
op --encrypted --secret-stdin item retry --vault "<box-id>"
```

作成のJSONに `item`、編集のJSONに `selectedFields`、再送のJSONに保持した `preparedWrite` を含める。
一覧は秘密値を表示しない。取得は利用者が明示した秘密値を標準出力へ出すため、出力先を管理する。
現在の利用者・所有者・鍵世代・バンドル版は毎回取得する。401・403・409や通信失敗を自動再送しない。
認証情報の永続保管は未対応であり、M4全体の完成を示さない。

### 暗号化モード（共有受信者の読取）

`--recipient --secret-stdin` を追加し、確認済みの送り手・自身の公開identity、
共有context、鍵世代、自身のidentityバンドル版を `sharedReceive` に明示する。
公開鍵は別手段で照合し、サーバーの返信からpinや期待世代を作らない。
入力の完全な形は [受信者の有限読取仕様](../spec/encrypted-cli.md#共有受信者の有限読取) を参照する。
項目の取得には独立した `itemContext`、添付にはさらに `attachmentContext` が必要。

```powershell
# 秘密管理ツールからJSONをパイプする。秘密値はargvに書かない。
op --encrypted --recipient --secret-stdin item list --vault "<box-id>"
op --encrypted --recipient --secret-stdin item get "<item-id>" --vault "<box-id>" --fields password
op --encrypted --recipient --secret-stdin read "op://<box-id>/<item-id>/password"
op --encrypted --recipient --secret-stdin attachment get "<attachment-id>" --item "<item-id>" --vault "<box-id>" --out "<new-file-path>"
```

添付の保存先は必ず利用者が指定する。既存ファイルは上書きしない。
成功時も標準出力には何も出さず、`--print-name` を付けたときだけ認証した元の名前をJSON文字列で返す。
受信者による書込み・鍵更新・移行・復旧は未対応。401・403・409を自動再送しない。

```powershell
cargo nextest run --locked -p op-cli -p passshare-connect
```

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
