# ADR 001: Vercel + Railway 4 環境構成

## Status

Accepted (2026-05-27)

## Context

Vercel / Railway リソース削除により GitHub デプロイチェックが失敗した。
既存 Vercel プロジェクト `pass-share-frontend` は Root Directory `frontend` を期待しているが、
MVP 再構築時に当該ディレクトリが存在しなかった。

## Decision

1. **Frontend**: Vercel (`pass-share-frontend`) に Vite ベースの Web ポータルを配置
2. **Backend**: Railway に Node.js API（ヘルスチェック + DB 接続確認）を配置
3. **Database**: Railway PostgreSQL を 3 インスタンス構成
   - `postgres-dev`: preview + dev で共有
   - `postgres-stg`: staging 専用
   - `postgres-prd-v2`: production 専用
4. **環境名**: Preview / dev / stg / prd の 4 論理環境を Vercel + Railway の標準環境にマッピング

## Consequences

- デスクトップアプリ（Tauri）と Web ポータルが共存する
- MVP v0.1 のローカル暗号化仕様は維持し、クラウド DB は将来の同期 / 共有機能（v0.2+）向けの基盤とする
- Railway CLI 認証が必要な初回セットアップは `scripts/setup-railway.ps1` で半自動化

## Alternatives Considered

- Vercel Postgres のみ: Railway との既存連携パターン（OmegaPortal）との一貫性を優先し不採用
- Tauri UI を Vercel Root に変更: デスクトップビルドと Web デプロイの責務が混在するため不採用
