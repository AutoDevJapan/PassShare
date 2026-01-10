## 目的
アーキテクチャの依存方向・境界・責務を明文化し、実装の一貫性を守る。

## 依存方向（バックエンド）
**Domain → Usecase → Infrastructure → Presentation**

- Domain: ビジネスルール、エンティティ/値オブジェクト、リポジトリIF、ドメイン例外
- Usecase: 入力→処理→出力、トランザクション境界、ドメイン/リポジトリIFを組み立てる
- Infrastructure: DB/外部I/O/実装詳細（リポジトリ実装など）
- Presentation: FastAPIのエンドポイント、入出力スキーマ、HTTP整形（薄く）

## フロントの責務
- UIは **表示に集中**し、副作用（取得/保存）は hooks/services に寄せる
- 状態は loading/error/empty/normal を揃え、UXを崩さない

## サービス間の大枠データフロー
- Frontend（`frontend`）→ Backend（`backend`）: REST（Axios/fetch）
- Backend（`backend`）→ MySQL: SQLAlchemy(async)（Docker利用時は同一ネットワーク）

## 仕様（Spec）の置き場
- Spec（SSOT）: `documents/spec/`
- 運用テンプレ: `documents/templates/`

## 境界違反の典型（禁止）
- PresentationがDBへ直接アクセスする（Usecase/Infraを飛び越える）
- DomainがInfrastructure/Presentationに依存する
- UIコンポーネントにデータ取得/永続化処理が埋め込まれる
