# 本番リリース Runbook

> Issue [#107](https://github.com/AutoDevJapan/PassShare/issues/107)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

## 概要

既存Prdだけへ配備する。PRは従来のQuality Gateと隔離DBで検査し、mainをdevへ配備する経路と、stg/previewの作成・配備は廃止した。開発PRはAIが別モデルレビューでMustを解消し、必須CI成功後にマージする。顧客契約で必要な人レビューは維持する。

SSOT: [ADR001](../adr/001-vercel-railway-environments.md), [infrastructure.md](../spec/infrastructure.md)。旧ADR008のdev-first手順は使用しない。

## 配備前の確認

1. 配備するmainのSHAと全CI成功を確認する。CHANGELOGを更新する。
2. 既存Prd project/backend/productionのIDを照合する。現DBはPG18 service `4fdfda2d-ed50-4396-9797-25ea7720f720`。旧 `postgres-prd-v2` を指定しない。
3. runtimeの接続先・スキーマ・必要行の対応と、変更のDB互換性を確認する。DB変更に必要な一時保全を既存資源と予算内で行う。永久有料backupの追加や旧stg受入をこの配備の前提にしない。
4. Vercelは既存project、Production Branch main、Prd build変数を照合する。旧非Prd資源の削除は、必要成果の移行とPrd機能確認を済ませてから、対象IDを確認して別途行う。

## 配備

### Railway workflow

GitHub Actionsの **Deploy Production Backend** をmain上で実行し、確認入力を`deploy-prd`にする。他branchではjobを実行しない。

workflowは既存production IDと現PG18サービスを検査し、client-18で一時snapshotを取得してから配備する。snapshotは現Prdだけの`pg_dump`であり、旧stg/devの復元に使わない。追加DB、proxy、有料backupを作らない。dumpはアップロード対象の外にある専用一時フォルダーへ置き、終了時に削除する。GitHub artifactには保存しない。永続保全や復元可能性をこのジョブだけで証明したとは扱わない。

### 既存OAuth CLIを使う場合

変更のないmainをcheckoutした専用作業先から実行する。APIキーを新規に指定せず、既存Railway CLIのOAuthログインを使用できる。

```powershell
$env:DEPLOY_TARGET = 'prd'
$env:RAILWAY_PROJECT_ID = '82730a82-b4d4-47d0-b578-f951465465fc'
$env:RAILWAY_SERVICE_ID = '29539998-d8d9-4e41-82a5-f71ca223f96c'
$env:RAILWAY_ENVIRONMENT_ID = 'c1a3cdfc-9aa3-420d-b101-e6497714ccb9'
$env:RAILWAY_PRODUCTION_ENV_ID = $env:RAILWAY_ENVIRONMENT_ID
$env:RAILWAY_HEALTH_URL = 'https://pass-share-backend-production.up.railway.app/health/db'
node scripts/railway-deploy-preflight.mjs --offline

# 上の確認が成功し、配備前のDB互換性と必要な一時保全を確認した場合だけ実行
bash scripts/railway-deploy-ci.sh
```

この直接CLI経路はdumpを自動取得しない。wrapperを使用する場合も`DB_REPLICA_MODE=skip`の意味は同じである。snapshotを使う経路は現Prd DB IDとpg_dump 18以上を別途必須とする。`refresh`、非Prd target/source、作業branch、既存Prd以外のIDは補助スクリプトが拒否する。ID明示に対応しないCLIは更新し、リンク先任せの`railway up`へ戻さない。

### Vercel

mainのGit integrationで既存Productionだけへ配備する。環境変数を更新する場合はmain上で **Sync Vercel Production Env** を手動実行する。`--baseline`はProductionの2変数だけを同期する。`setup-vercel.ps1`も同期だけであり、CLIのPreview配備・project作成・linkを行わない。旧`setup-railway.ps1`と`provision-railway-api.ps1`は再作成を防ぐため停止する。

## 配備後の確認

1. upload受付とbuild成功を区別し、実deployment成功・runtime SHA・DB接続先を照合する。
2. Prdの`/health`と`/health/db`を読取りで確認する。
3. 既存URL、ログイン、購入、保存、復元を該当機能ごとに確認する。実決済・顧客への実メール・本番破壊操作を試験にしない。専用架空データを使う隔離試験とPrd実確認を混同しない。
4. main/PRで新しい非Prd配備を作らないことと、旧資源の廃止後の不在をproviderで確認する。ソースguardの成功だけを実廃止の証拠にしない。
5. SemVer tag、Desktop配布、CHANGELOG確定は各既存手順に従う。

DesktopのM7-Aには、タグや公開を行わない[手動の署名候補工程](./desktop-release.md#m7-aの手動署名候補工程準備コード実署名は未実施)を先に使う。既存鍵・証明書・公証環境が無ければ失敗させ、候補の実署名と対応OSでの導入・更新・削除を確認する。非公開CI成果物の保存だけでこの本番リリースや販売の完了を判断しない。

## Rollback

### Backend（Railway）

1. Railway Dashboard → 既存production → Deployments
2. 現DBスキーマとの互換性と必要な認証修正を維持する版を確認して **Redeploy**。単に直前の成功版へ戻さない
3. `/health` と `/health/db`、現在の資格による保存と旧資格の拒否を確認

### Frontend（Vercel）

1. Vercel Dashboard → Deployments → 直前の Production deployment
2. **Promote to Production**

### DB

- 稼働DBと現在の更新を先に保全し、別の隔離DBへ復元する。公開artifactの実DB dumpを復元元にしない
- 本番の現在の永続DBと、プラン・予算内で有効な保全設定は[運用Runbook](./operations.md#railway-postgresql)で照合する。元PG16へ戻して新しい更新を消さない
- PITRは対象サービスの実設定を確認して利用する。本番の有効化は未実施。復元した古い資格・退会・取消・鍵を現在の記録へ合わせ、全経路の拒否と認可を確認するまで再開しない

## Hotfix

1. `main` から `hotfix/<summary>-YYYYMMDD` ブランチ
2. 修正 + Quality Gate green → PR → `main` マージ
3. PRの隔離試験とmainのCI成功を確認
4. main上でPrd手動配備を実行し、実稼働を確認

## 演習記録

| 日付 | 種別 | 実施者 | 結果 | 備考 |
|------|------|--------|------|------|
| 2026-05-28 | 旧パイプライン変更 | — | ADR008の履歴 | main → dev、stg/prd手動。ToDo2379で廃止 |

## 関連

- [release-versioning.md](../spec/release-versioning.md)
- [staging-acceptance.md](./staging-acceptance.md)
- [secret-rotation.md](./secret-rotation.md)
- [ADR 008](../adr/008-deploy-pipeline-dev-first.md)

## 固定ソースの配備記録（2026-10-06）

共有ToDo1177では既存Railway CLIのOAuthログインを使用し、APIキー指定のワークフローを起動していない。全42検査が成功したmain `e7d076c0449b3a233f015c3b6e003ab2796e8bd9` を変更のない専用作業フォルダーから対象プロジェクト・本番環境・backendサービスのIDを明示して配備した。実際のアップロード先、Dockerfileによるnative build、稼働44ソースファイルの一致と正式API15項目を確認した。

先に本番の手動snapshotを取得した。切替前の保全先snapshot復元で元8表の件数・全文指紋が一致した証拠と、配備後のsource一致・API資格失効は別の判定である。この限定経路をstaging全受入、署名された配布物、全クライアント、契約上の提供開始と同一に扱わない。[匿名証拠](../audits/evidence/1177-live-operations-20261006.json)と[復旧手順](./operations.md)を参照する。
