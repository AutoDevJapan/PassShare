## 目的
DDD（Domain-Driven Design）を前提に、Domain層の責務とルールを明確化する。

## Domain層の責務
- **エンティティ/値オブジェクト**: ビジネスルールを内包する
- **ドメインサービス**: 単一エンティティに属さないルールを表現する
- **リポジトリIF**: 永続化の抽象（実装はInfrastructure）
- **ドメイン例外（or ドメインエラー型）**: ルール違反を表現する

## 禁止
- Domain層からInfrastructure/Presentationへの依存
- HTTP/DB/外部I/O前提の型や概念をDomainへ持ち込むこと

## ユビキタス言語（推奨）
- 重要な用語は Spec（`documents/spec`）に用語として残し、命名の揺れを抑える

## エラーの扱い（方針）
- Domainの例外/エラーは「ビジネスルール違反」を表す
- HTTPへの変換はPresentationで行う（ドメインがHTTPを知らない）
- ユーザー向けのエラー設計は `documents/spec/error-codes-template.md` を参照する


