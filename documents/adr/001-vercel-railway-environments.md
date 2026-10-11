# ADR 001: Vercel + Railway Prd-only環境構成

## Status

Accepted (2026-05-27), amended (2026-10-12, ToDo2379).

## Context

Vercelの既存frontend projectはRoot Directory `frontend`を使用する。従来はPreview/dev/stg/prdの4環境と3 DBを設け、mainをdevへ配備していた。2026-10-11の本人指示により、稼働する製品サイトは既存Prdだけに統一する。旧環境の必要成果を照合せず削除したり、本番DBを旧DBへ戻したりしない。

## Decision

1. Frontendは既存Vercel `pass-share-frontend`のProductionへ、mainだけをGit配備する。`git.deploymentEnabled`でその他のbranchを停止し、provider側のPreview停止と過去配備の廃止も別途確認する。
2. Backendは既存Railway project/backend/productionのIDを指定する。main上の手動Prd workflowを保持し、dev/stg/preview配備・同期・staging smoke workflowを廃止する。
3. Databaseは**現稼働** `passshare-postgres-preserved-1177`（PG18、service `4fdfda2d-ed50-4396-9797-25ea7720f720`）。旧 `postgres-prd-v2`（`1509c487-cf03-4c50-8c9d-8781d53ee19a`）は切替後の更新を持たないため、復元元・現在のdump先として使わない。
4. production snapshotは現Prdだけを読む一時dumpで、非Prd replicaへのrestoreは行わない。PG18クライアントと既存接続を使用し、追加DB・proxy・永久有料backupを自動作成しない。終了時にdumpを削除し、Actions artifactには保存しない。
5. 手動補助もmainと既存Prd IDを検査する。旧bootstrap/provisioningは停止する。リンク先任せのCLI配備、Preview/Development同期、prd→stg/dev refreshは拒否する。
6. localhost開発、PR CIの隔離試験、一時DBを維持する。公開された非Prdの運用と区別し、試験を実Prdへの破壊操作にしない。人間レビューを求める規則は変更しない。

## Consequences

- 旧ADR008のdev-first配備経路はこの決定と[infrastructure.md](../spec/infrastructure.md)へ置き換える。
- 配備コードの変更だけで旧provider資源が削除されたとは判断しない。所有者/source/consumer、必要成果の移行、Prd機能、廃止後の不在、再作成停止を実測する。
- 新しい永久保全の費用を配備の前提にしない。既存運用とプランに応じた保管の設計は維持し、実設定は照合する。
- 確認済みの現資源IDと、本番リリース手順は[infrastructure.md](../spec/infrastructure.md)と[production-release.md](../runbooks/production-release.md)に集約する。

## Historical Alternatives

2026-05-27はVercel Postgresだけの構成と、Tauri UIをVercel Rootへ移す構成を検討した。既存のVercel/Railway構成と、desktop/webの役割を維持する。4稼働環境の再作成は現在の選択肢に含めない。
