# PassShare インフラ構成 (SSOT)

> 最終更新: 2026-10-12（ToDo2379: 配備先を既存Prdだけへ限定。実providerの廃止・DB照合は別途実測）

## Railway プロジェクト ID

| リソース | ID / URL |
|---------|----------|
| Project | `82730a82-b4d4-47d0-b578-f951465465fc` |
| Backend Service | `29539998-d8d9-4e41-82a5-f71ca223f96c` |
| 旧postgres-dev（廃止対象・削除確認前） | `43bc8dc5-c9c9-4fa3-9b7e-fd9079fd5c0a` |
| 旧postgres-stg（廃止対象・削除確認前） | `7234bbc3-c482-4009-9c88-03063521ffd1` |
| 本番の現稼働DB | `4fdfda2d-ed50-4396-9797-25ea7720f720`、passshare-postgres-preserved-1177（PG18、永続volume） |
| postgres-prd-v2 | `1509c487-cf03-4c50-8c9d-8781d53ee19a`（旧本番、切替後の更新は同期されない） |
| production env | `c1a3cdfc-9aa3-420d-b101-e6497714ccb9` |
| 旧staging env（廃止対象） | `c807d209-0624-4e13-aff6-61332cd0bb29` |
| 旧preview env（廃止対象） | `9bed9d58-203f-4bb5-bb17-858bcb3e2513` |
| 旧development env（廃止対象） | `0951c467-6bc3-418f-af75-a96e810f4946` |

### Backend URL

| 環境 | URL |
|------|-----|
| prd | https://pass-share-backend-production.up.railway.app |

旧stg/preview/devのURLは配備・同期・検査の送り先にしない。上の旧IDは移行と廃止の照合用履歴であり、削除済みという意味ではない。

## 概要

| レイヤー | プラットフォーム | 役割 |
|---------|----------------|------|
| Frontend | Vercel (`pass-share-frontend`) | Web ポータル（Vite） |
| Backend API | Railway (`pass-share-backend`) | Connect API `/v1` + ヘルスチェック |
| Database | Railway PostgreSQL | 既存Prdの永続PG18 |

## Backend ヘルスチェック / コールドスタート耐性（#368）

### ヘルスチェックエンドポイント

| パス | 種別 | 挙動 |
|------|------|------|
| `/health` | liveness | DB 非依存で常に 200。Railway の `healthcheckPath`（`backend/railway.toml`）に設定。 |
| `/health/db` | readiness | `SELECT 1` を実行し、DB 到達可否で 200 / 503 を返す。IP ごとに60秒で60件まで受け付け、超過時は問い合わせ前に429。 |

### 事象と根本原因

本番フロント初回ロード時、`/api/auth/csrf` が Railway エッジ（`railway-hikari`）から数回 **503** を返し、リトライで 200 に回復する事象が観測された（[#368](https://github.com/AutoDevJapan/PassShare/issues/368)）。原因はアイドル後 / 再デプロイ直後の **コンテナ・コールドスタート**で、healthy replica が存在しない一瞬の窓でエッジが 503 を返すため。この窓は `app.listen` より前に発生するため、**バックエンドのコード単体ではこの 503 窓そのものを消せない**。

### アプリ側で実装済みの緩和

- **フロント: バックオフ付きリトライ**（`frontend/src/lib/auth-api.ts` の `fetchWithRetry`）— transient `502 / 503 / 504` は全メソッドで、ネットワーク例外は冪等な GET のみ、指数バックオフ + フルジッターで最大 4 回リトライして 503 窓を吸収する。ユーザに `Failed to fetch` を見せずに初回リクエストを成立させる。
- **バックエンド: DB プールウォームアップ**（`backend/src/app.js` の `warmUpPool`）— 起動時に best-effort で `SELECT 1` を短いリトライ付きで実行し、コールドスタート直後の初回 DB リクエストが接続確立レイテンシを払わずに済むようにする。失敗しても非 fatal（liveness は維持される）。

### 純インフラ側の推奨（本タスク対象外・手動対応が必要）

- **prd Backend サービスの min replicas を 1 以上にする / app sleep を無効化する** — コールドスタート窓そのものを恒久的に解消する唯一の手段。実インフラ操作は本タスクのスコープ外のため、別途手動対応が必要（Railway の service settings）。
- （任意）`healthcheckPath` を readiness（`/health/db`）へ切替えると、DB 接続確立後にのみトラフィックが流れる。ただし DB の一過性障害でサービス全体が unhealthy 判定 → 再起動ループに陥るリスクがあるため、現状は liveness（`/health`）を維持する。

## 環境マッピング

| 論理環境 | Vercel | Git ブランチ | Railway Environment | DB | Backend デプロイ |
|---------|--------|-------------|---------------------|-----|-----------------|
| **prd** | Production | `main` | `production` | `passshare-postgres-preserved-1177`（永続PG18） | main限定の手動配備 |
| 開発・CI | 公開配備なし | PR / 作業ブランチ | 作成しない | localhost / CIの一時DB | 隔離試験のみ |

ToDo2379のPrd-only方針が旧ADR008のdev-first配備を置き換える。PRとmainのQuality Gate、Docker隔離試験、一時DBは維持する。稼働dev/stg/previewの作成・配備は廃止する。人間レビューを求める規則は変更しない。

### production snapshotの依存

- `railway-db-replica.mjs snapshot --source prd` は現Prd DBだけを読み、一時的なcustom-format dumpを作る。dev/stgへの復元も、本番への書込みも行わない。`refresh` と非Prd source/targetは接続前に拒否する。
- 必須IDはproject、production環境、**現稼働PG18サービス**。旧 `postgres-prd-v2` のIDは拒否する。backendサービスとDBサービスは別IDであり、取り違えない。
- PostgreSQLクライアントは18以上。ジョブではPGDGのclient-18を使用する。[pg_dump公式資料](https://www.postgresql.org/docs/18/app-pgdump.html)のバージョン制約に従う。
- 接続は現Prdサービスから取得した既存のpublic URL / TCP proxyだけを使用し、接続overrideは拒否する。proxyやDBを自動作成しない。存在しなければ停止する。秘密値は報告・artifactへ出さない。
- provider操作を伴わない関連検査: `node --test scripts/railway-db-replica.test.mjs`、`node backend/scripts/verify-schema.mjs`、変更したworkflowのactionlint、配備shellの`bash -n`。最終CIと実配備確認は別途行う。
- wrapperはアップロード対象の外に専用一時フォルダーを作り、dumpへのアクセスを制限する。成功・失敗のいずれでも終了時にdumpとフォルダーを削除する。runner破棄でも一時資源は残さない。Actions artifactへのアップロードは禁止。
- このdumpは永続バックアップでも復元成功の証拠でもない。配備のために旧環境や追加の有料バックアップを必要としない。有料利用者がいない製品には新しい永続保全費用を増やさない。
- 手動OAuth配備で`DB_REPLICA_MODE=skip`を使う場合は、必要な一時保全と現在のDB互換性を確認する。無償・既存資源での保全と、プランに応じた有料保管を区別する。

### ログイン throttle / lockout ストア（#378）

- ログイン失敗ロックアウト（`login_failures`）と per-IP スロットル（`login_ip_requests`）の状態は **既存の PostgreSQL を流用**して共有する。**Redis は追加しない**（新規インフラ依存を増やさない方針）
- これにより backend を水平スケールしても **多重インスタンス間でロックアウト/スロットルが共有**され、デプロイ・再起動をまたいで **状態が維持**される
- ストア選択は `backend/src/auth/login-guard-store.js` が担う。既定は `memory-*` / `pg-*` の auth store と同じく **`DATABASE_URL` の有無**（pool あり → pg / なし → memory）。環境変数 `LOGIN_GUARD_STORE`（`pg` | `memory`）で明示上書き可能
- **local / test はインメモリのまま**（依存追加なしで動作）。TTL は `LOGIN_LOCKOUT_MS` / `LOGIN_IP_WINDOW_MS` に対応し、`expires_at` フィルタ＋opportunistic sweep でストア側失効
- テーブルは `backend/src/db/auth-schema.js`（auth store migration）で作成。実 DB を使う共有検証は `backend/test/login-guard-pg.integration.test.js`（Docker backend-e2e で実行）

### 開発用seed（localhost / CIの隔離DBのみ）

| 項目 | 値 |
|------|-----|
| Email | `dev@passshare.local` |
| Password | `DevPassShare1!` |
| Password box ID | `abcdefghijklmnopqrstuvwxyz` |
| Password box name | `Demo Password Box` |

手動適用は隔離DBに限る: `APP_ENV=local DATABASE_URL=<isolated-db> pnpm --dir backend run db:seed`。Prdや旧稼働環境を指定しない。

## Vercel 環境変数

| 変数 | Production |
|------|------------|
| `VITE_APP_ENV` | `prd` |
| `VITE_API_BASE_URL` | `/backend/prd` |

### Prdだけの環境変数同期とGit配備

`sync-vercel-env.yml` はmain上の手動実行だけ。`scripts/sync-vercel-env.mjs --baseline` は明示した既存projectのProductionへ上の2変数だけをupsertする。旧Preview/Development/remote branch同期の引数は通信前に拒否する。旧変数の削除は実providerの依存照合後に別途行う。

`frontend/vercel.json` の `git.deploymentEnabled` は `*` と `**` をfalse、`main`だけtrueにする。スラッシュを含むfeatureブランチも停止する。[Vercel公式Git設定](https://vercel.com/docs/project-configuration/git-configuration)に従う。実projectのProduction Branchがmainであること、Preview作成停止設定、過去配備の不在はprovider側でも確認する。Git設定だけで手動CLIや過去Previewを削除したとは扱わない。

`/backend/dev` と `/backend/stg` の外部rewriteは削除する。正式ホストに限定した `/backend/prd` とSPA rewrite、セキュリティheaderは維持する。localhostの開発proxyやCIの隔離DBは本番に置き換えない。

### Vercel ビルド（monorepo）

Root Directory は `frontend`。`@passshare/connect`（`file:../packages/connect-js`）を解決するため、`frontend/vercel.json` の `installCommand` で connect-js を先に install + build してから frontend を install する。

### セキュリティ監査（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push / nightly schedule | `security-audit.yml` | `cargo audit` + 各パッケージ `pnpm audit --audit-level=high`（pnpm-lock がある場合） |

依存 advisory 監査は `security-audit.yml` の単一 SSOT（`quality-gate.yml` の重複 `security` job は削除、#325）。新規 CVE 公開で無関係 PR が赤くならないよう **PR では非ブロッキング（`continue-on-error`）**、**main push + nightly schedule では hard gate**。`cargo-audit` は SHA-pin した `taiki-e/install-action` のプリビルドバイナリで導入（ソースビルドの crates.io flakiness 回避）。

SSOT: [vulnerability-sla.md](../security/vulnerability-sla.md), [audit-checklist.md](../security/audit-checklist.md)

### Dependabot（npm）

| 対象 | ポリシー |
|------|---------|
| UI workspace（`frontend/`, `apps/desktop/`, `apps/mobile/`, `packages/extension/`）の `vite` | **メジャー upgrade は ignore** — 4 workspace を同一 PR で統合対応（Issue 起票 → 一括 PR） |
| 同上の `@vitejs/plugin-react` | **メジャー upgrade は ignore** — 同上 |
| 上記以外 | daily / weekly スケジュールで通常どおり PR |

### Dependabot（cargo）

| 対象 | ポリシー |
|------|---------|
| `rand` | **メジャー upgrade は ignore** — API 移行（例: `thread_rng` → `rng`）を Issue/PR で対応 |

設定: `.github/dependabot.yml`

### 統合 Quality Gate（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml` | Rust Docker + Docker E2E (PG) + Backend + Connect SDK + Web E2E + Extension + Desktop/Mobile smoke + Benchmark → job `gate` |

`quality-gate.yml` が Backend / Connect / Web E2E テストの単一 SSOT（重複ワークフローは統合済み、#325）。依存 advisory 監査は `security-audit.yml` に集約（PR は非ブロッキング、main + nightly schedule で hard gate）。`desktop-build.yml` 等のビルド系ワークフローは引き続き並行実行。Quality Gate が Epic #36 の完了条件 SSOT。

### Docker E2E（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml` | `docker compose run backend-e2e` — PostgreSQL + Connect API + op-cli E2E |

```bash
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e
```

### ステージング smoke

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| 手動 | `stg-smoke.yml` | `scripts/stg-smoke.mjs` — stg Backend health + Connect |

SSOT: [staging-acceptance.md](../runbooks/staging-acceptance.md)

### Web ドキュメント・法務（Epic #37）

| パス | 内容 |
|------|------|
| `/docs` | ドキュメントハブ |
| `/docs/user-guide` | ユーザーガイド |
| `/docs/extension` | 拡張機能インストール |
| `/faq` | FAQ |
| `/terms` | 利用規約（草案） |
| `/privacy` | プライバシーポリシー（草案） |

SSOT: [documents/guides/](../guides/), [documents/legal/](../legal/)

### Backend テスト（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml`（jobs `backend` / `connect-types` / `connect-js`） | pnpm test + migrate:verify + Connect 型 drift チェック |

SSOT: [audit-checklist.md](../security/audit-checklist.md), [connect-api-gap-analysis.md](./connect-api-gap-analysis.md)

### Frontend E2E（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `quality-gate.yml`（job `frontend`） | Playwright signup → CRUD → logout + frontend build |

### Desktop ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `desktop-build.yml` | Rust smoke + Tauri 3 OS ビルド（MSI/DMG/AppImage/deb） |

SSOT: [desktop-release.md](../runbooks/desktop-release.md)

### Mobile ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `mobile-build.yml` | Rust smoke + mobile frontend build + mobile auth API tests |
| PR / main push | `extension-build.yml` | Extension unit tests + MV3 build + extension auth API + Playwright popup smoke |

SSOT: [mobile-store-release.md](../runbooks/mobile-store-release.md)

### Extension ビルド（CI）

| トリガー | ワークフロー | 動作 |
|---------|-------------|------|
| PR / main push | `extension-build.yml` | Extension unit tests + MV3 build + extension auth API + Playwright popup smoke |

SSOT: [extension-store-release.md](../runbooks/extension-store-release.md)

## Railway 構成

維持する既存稼働先:

```text
PassShare (existing project)
├── pass-share-backend (service)
│   └── production → passshare-postgres-preserved-1177
└── passshare-postgres-preserved-1177 (current production, PG18)
```

旧staging/preview/development、postgres-dev/stg、旧本番postgres-prd-v2は廃止・必要成果照合用の履歴であり、再作成しない。実削除済みの判断にはprovider証拠を使用する。
現Prd backendのVariables（旧環境の設定は再作成しない）:

| 変数 | 値 |
|------|-----|
| `APP_ENV` | `prd` |
| `DATABASE_URL` | 現稼働PG18のVariable Reference |
| `WEB_ORIGIN` | カスタムフロントドメイン。**prd はカスタムドメイン `https://pass-share.bm1314.net` を設定して配信**（bare `pass-share-frontend.vercel.app` alias は現状デプロイ未アタッチで 404、[#374](https://github.com/AutoDevJapan/PassShare/issues/374)）。未設定時はプロジェクト prefix に束縛した Vercel オリジン（`pass-share-frontend.vercel.app` と `pass-share-frontend-git-*` プレビュー）のみ CORS 許可。任意の `*.vercel.app` は信頼しない（[#46](https://github.com/AutoDevJapan/PassShare/issues/46), [#315](https://github.com/AutoDevJapan/PassShare/issues/315)） |
| `VERCEL_TEAM_SLUG` | 旧preview CORS設定。Prdには設定しない。旧稼働環境の作成・配備には使用しない |
| per-user Connect token | PrdのConnect APIはユーザー単位の資格を使用。旧環境用の共有`OP_CONNECT_TOKEN`を配備しない |
| `TRUST_PROXY_HOPS` | 信頼するフロントプロキシのホップ数（`req.ip` 算出用）。省略時は `local`=0 / それ以外=1（Railway エッジ 1 段）。生の `X-Forwarded-For` は信頼せず per-IP スロットルのバイパスを防ぐ（[#316](https://github.com/AutoDevJapan/PassShare/issues/316)）。プロキシ段数変更時のみ設定 |
| `DATABASE_CA_CERT` | DB 接続の TLS 検証に用いる CA 証明書（PEM 文字列）。設定時は `rejectUnauthorized: true` でサーバ証明書を検証。標準 URL のホスト名が `*.railway.internal`（私設ネットワーク）の場合だけ TLS 不要のため無視。CAのない、TLS指定のないループバック接続（`localhost` / `127.0.0.1` / `[::1]`）と、運用者が私設ネットワーク内と宣言した完全一致ホストも TLS 不要。それ以外のホストは Railway の公開/プロキシを含め証明書検証必須。URL の `sslmode=disable` 等ではこの方針を変更できない（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
| `DATABASE_TRUSTED_PRIVATE_HOSTS` | 運用者が管理する私設ネットワーク内のDBホスト名を、カンマ区切りで明示する。未設定時は追加の信頼なし。例は所有するDockerネットワークの `postgres`。完全一致のみで、サブドメイン・接尾辞・URL内の文字列では一致しない。CA指定またはURLのTLS要求があれば検証付きTLSを優先する。公開・外部DBをここへ登録しない。 |
| `DATABASE_SSL_ALLOW_INSECURE` | `true` の時のみ公開ホストの TLS 証明書検証を無効化する明示的オプトアウト（MITM リスクあり・非推奨）。既定は検証有効（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
| `METRICS_TOKEN` | `/metrics`（RSS/uptime 等の内部情報）の認証トークン。設定時は `Authorization: Bearer <token>` 必須で、不一致は 404。未設定時は `local` 以外のデプロイ環境で `/metrics` を無効化（404）し無認証の情報漏洩を防ぐ（[#323](https://github.com/AutoDevJapan/PassShare/issues/323)） |
| `PORT` | Railway が自動設定（省略可） |

DB の接続先は URL のホスト名で判定する。パスワード・パス・クエリ内のドメイン文字列や、`postgres.railway.internal.evil.example` は私設ネットワークとして扱わない。クエリでの `host` 上書きと不正な `sslmode` は、入力を含まない設定エラーで拒否する。`sslmode` が複数ある場合は pg と同じく最後の値を採用する。Pool に渡す URL から `ssl` / `sslmode` / `sslcert` / `sslkey` / `sslrootcert` / `uselibpqcompat` / `sslnegotiation` を除き、pg による TLS 設定の上書きや証明書ファイルの読み込みを防ぐ。CA は `DATABASE_CA_CERT` に設定する。URL の証明書ファイル指定は使用しない。`sslnegotiation=direct` は TLS 接続に限り Pool の独立した設定として渡し、CA と検証設定を維持する。私設ネットワークと TLS 指定のないループバック接続では Pool の `ssl: false` と通常の接続方式を明示し、`PGSSLMODE` / `PGSSLNEGOTIATION` で接続方針を上書きできない。ただし `sslnegotiation` / `PGSSLNEGOTIATION` の不正な方式名は、TLS不要の場合も起動時に設定エラーで拒否する。

`DATABASE_TRUSTED_PRIVATE_HOSTS` は、運用者がそのネットワークと名前解決を管理し、接続が外へ出ないことを確認した場合にだけ設定する。設定自体がネットワークを隔離するわけではない。ASCIIのホスト名・IPv4リテラルを受け付け、DNSラベルは63文字以下、全体は253文字以下とする。前後の空白と英字の大小文字を正規化し、ワイルドカード・URL・ポート・認証情報・パス・クエリ・空の要素・パーセント符号化は拒否する。宣言はpgが実際に消費するホスト名に完全一致する場合だけ使い、URLの末尾ドットを除去して宣言の範囲を広げない。URL側の同名クエリや `APP_ENV=test` だけでは信頼を追加できない。宣言したホストもCAがあれば検証付きTLSになり、`sslmode=require` / `sslmode=no-verify` / `sslnegotiation=direct` 等のTLS要求を平文へ落とさない。既存のRailway VPCの扱いは変更しない。

復元検証では、ワークフローが作った未公開の `--internal` Dockerネットワークで、Node子プロセスだけに固定の `postgres` を宣言する。暗号化ストレージの配布イメージ検証では、検査用に生成して所有するDBコンテナ名を、そのAPIコンテナだけに宣言する。検証用の公開DBポートはループバック限定。短いホスト名やテスト環境という理由だけで公開接続のTLSを無効にする仕組みにはしない。

`/health/db` と認証成功後の `/metrics` は、それぞれクライアント IP ごと・プロセスごとに60秒で60件まで受け付ける。監視は各経路で1秒に1回以下を目安とし、同じ IP を使う監視元が複数ある場合は合計を調整する。超過時は DB 問い合わせの前に429を返し、`Retry-After` と `RateLimit-*` を付ける。両経路の枠は独立し、再起動・レプリカ間では共有しない。IP は既存の `TRUST_PROXY_HOPS` 方針で求める。`/metrics` の認証失敗は引き続き404となり監視の枠を消費しない。DB に問い合わせない `/health` はこの制限の対象外。

## 既存Prdへの配備手順

新project・新環境を作るbootstrapは使わない。`setup-railway.ps1` と `provision-railway-api.ps1` は処理の冒頭で停止する。`setup-vercel.ps1` は既存Prdの環境変数を同期するだけで、project作成・link・CLI配備はしない。

### GitHub Secrets（既存Prd用、値は表示しない）

| Secret | 説明 |
|--------|------|
| `RAILWAY_API_TOKEN` | 既存GraphQL preflight / snapshotの認証。手動では既存CLI OAuthを使用できる |
| `RAILWAY_PROJECT_ID` | 上記の既存PassShare project ID |
| `RAILWAY_SERVICE_ID` | 上記の既存backendサービスID |
| `RAILWAY_PRODUCTION_ENV_ID` | 上記のproduction環境ID |
| `RAILWAY_POSTGRES_PRD_SERVICE_ID` | **現稼働PG18** `4fdfda2d-ed50-4396-9797-25ea7720f720`。旧PG16を使わない |
| `VERCEL_TOKEN` | 既存Vercel同期の認証 |
| `VERCEL_ORG_ID` | 既存Prd project所有teamのslug（実所有者と照合） |
| `VERCEL_PROJECT_ID` | `prj_itSKGa2HAEj3UNHnsCdPQEF5nziE` |

非Prdの配備用secret参照は廃止した。secretの実削除と現在のPrd用IDのreadbackはprovider担当が行い、ソース変更だけで済んだとは判断しない。

### GitHub Actions デプロイ

| ワークフロー | トリガー | 先 | DB 前処理 |
|-------------|---------|-----|----------|
| `deploy-prd.yml` | main上の手動実行、`deploy-prd` 入力 | 既存Railway production | 現Prdだけの一時snapshot |
| `sync-vercel-env.yml` | main上の手動実行 | 既存Vercel Production変数 | なし |
| Quality Gate等 | PR / main（従来どおり） | 公開配備なし | CIの隔離試験を維持 |

`deploy-dev.yml`、`deploy-stg.yml`、`deploy-preview.yml`、`stg-smoke.yml` は削除した。

- `railway up` はリポジトリルートから、project・service・environmentのIDを必ず明示する。リンク先任せの実行は廃止し、明示指定に対応しないCLIでは失敗する。
- `railway-deploy-ci.sh` とwrapperは配備前に既存Prd ID、`DEPLOY_TARGET=prd`、main、未追跡ファイルもないmainソース（Gitが無視する生成物は除く）、Prd health URLを検査する。CIではcheckoutしたSHAとイベントSHAも照合する。
- wrapperはsnapshotかskipだけを許可する。`refresh`、非Prd、replica targetを拒否する。旧環境・有料backupサービスに依存しない。
- `railway-deploy-preflight.mjs --offline` はproviderに接続せず上記を検査する。token使用時は追加のAPI preflightでproject所属も検査し、手動OAuthでは明示IDのCLI配備を使用する。
- 手順と実配備の記録は[本番リリースRunbook](../runbooks/production-release.md)を参照する。`--detach`の受付と実配備成功・稼働SHA一致を分けて確認する。

### デプロイ失敗 vs DB 障害の切り分け

| 症状 | 原因 | 確認方法 |
|------|------|----------|
| CIのupload認証失敗 | token種別・対象project/service/environment・認証方式を照合 | Account tokenは`RAILWAY_API_TOKEN`のまま使用し、`RAILWAY_TOKEN`を解除。現在のpreflightとCLIを確認する |
| CI で `load metadata for docker.io/...` 後に `Deploy failed` | Railway ビルド（Docker Hub メタデータ取得）の一時失敗 | Railway ビルドログ。`/health/db` はデプロイ前の旧リビジョンのまま 200 のことがある |
| `/health` 200 だが `/health/db` 503 `database: unreachable` | `DATABASE_URL` 未設定・Variable Reference 切れ・Postgres 停止 | Railway Variables + Postgres サービス状態 |
| `/health/db` 503 `database: not_configured` | backend に `DATABASE_URL` がない | 現PrdのVariable Referenceを確認 |
| `migrate:verify` pass だが DB 不通 | **正常** — `migrate:verify` は `schema.js` の静的検証のみ（ live DB 非接続） | デプロイ後 smoke: `curl .../health/db` |

Prdの読取りhealth確認（実配備成功や全機能の合格とは別）:

```powershell
Invoke-RestMethod 'https://pass-share-backend-production.up.railway.app/health/db'
```

### 旧 Railway プロジェクト（profound-growth）

| 項目 | 値 |
|------|-----|
| Project ID | `123ba0fb-eac6-479e-bd7e-79210bfbd968`（**未使用・削除候補**） |
| 症状 | main push 時に `profound-growth - PassShare` チェックが `Deployment failed` になる |
| 原因 | `rootDirectory` 未設定のままモノレポ全体をビルドしようとする |
| 対応 | 2026-05-27: サービス `7f409e25-...` の GitHub 連携を `serviceDisconnect` で解除済み |

旧projectの削除は実所有者・source・consumer・必要成果を照合して判断する。この履歴だけで削除を進めない。

## 受入基準 (ATDD)

```gherkin
Given 既存Vercel projectのProduction Branchがmainである
When mainにpushする
Then Productionだけを配備し、PRとその他のbranchは公開配備を作成しない

Given PRとmainのQuality Gateが有効である
When 隔離試験を実行する
Then 一時DBを使用し、稼働非Prdや実Prd DBを作成・変更しない

Given main、既存Prd ID、現PG18 DBを指定した手動配備である
When deploy-prdを確認入力する
Then 現Prdだけの一時snapshotを取得し既存production backendへ配備する
And 旧環境へのrefreshと有料backupサービスを必要としない

Given 非Prd ID、作業branch、旧DB ID、または旧同期引数である
When 手動の配備・同期・snapshot補助を実行する
Then provider変更前に失敗する
```

## 関連ドキュメント

- [ADR 001: Vercel + Railway 環境構成](../adr/001-vercel-railway-environments.md)
- [MVP 機能仕様](./feature-passshare-mvp.md)

## 2026-10-06の現設定との照合

2026-10-06時点の履歴では本番backendは永続PG18へ切替済み。日次保持6日の設定と手動snapshotの復元は[運用記録](../audits/operations-readiness.md#2026-10-06の再現可能な演習とrailway実検証)へ保存した。元8表の保全と、固定e7の稼働44ファイル・実API15項目は別の確認である。

旧本番DBを参照する履歴やprovision用の例を、現在の稼働先として採用しない。既存GitHub配備・レプリカ用の保存先IDとPostgreSQLクライアントの互換性は、この切替で検証したものではない。ToDo2379のソースguardは現稼働DBのIDとpg_dump 18以上を必須にした。保存済みsecretの実値・runtime接続・件数・スキーマは別途照合する。未確認のジョブ内dumpを永続バックアップと数えない。

Webの同一サイト経路は[認証経路の仕様](./web-auth-routing.md)を参照する。元のRailway絶対URLをブラウザから使用すると、SameSite=Lax Cookieが別サイト扱いで拒否される。Prdの相対接頭辞とVercel外部rewriteを使用し、本番接頭辞は正式ホストだけへ許可する。ソース設定とVercelの実build値は別々に照合する。
