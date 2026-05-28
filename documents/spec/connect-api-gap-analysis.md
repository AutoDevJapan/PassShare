# Connect API OpenAPI ギャップ分析（Issue #51）

> SSOT: `documents/spec/openapi/connect-api.yaml`  
> 実装: `backend/src/connect/`  
> 最終更新: 2026-05-28

## 目的

1Password Connect API 互換 OpenAPI と PassShare backend 実装の差分を Must / Should に分類し、Epic [#30](https://github.com/AutoDevJapan/PassShare/issues/30) 完了判定の根拠とする。

## Must 定義

Epic #30 完了条件「OpenAPI Must ギャップ 0」は次を満たすこと:

1. OpenAPI `paths` に定義された Connect `/v1` エンドポイントが backend に存在する
2. PassShare 拡張（`x-passshare-*`）で Must と明記されたエンドポイントが実装されている
3. 統合テスト（Issue #58）が Must エンドポイントと PS012–PS016 をカバーする
4. 運用 Must（#56 マイグレーション CI、#59 トークン Runbook）が文書化・CI 化されている

Should は Epic 完了のブロッカーとしない（P1 として別途追跡）。

## パスレベル比較

| Method | OpenAPI Path | 実装 | Must 状態 |
|--------|--------------|------|-----------|
| GET | `/vaults` | ✅ `router.js` | ✅ |
| GET | `/vaults/{vaultUuid}` | ✅ | ✅ |
| GET | `/vaults/{vaultUuid}/items` | ✅ | ✅ |
| POST | `/vaults/{vaultUuid}/items` | ✅ | ✅ |
| GET | `/vaults/{vaultUuid}/items/{itemUuid}` | ✅ | ✅ |
| PUT | `/vaults/{vaultUuid}/items/{itemUuid}` | ✅ | ✅ |
| PATCH | `/vaults/{vaultUuid}/items/{itemUuid}` | ✅ | ✅ |
| DELETE | `/vaults/{vaultUuid}/items/{itemUuid}` | ✅ | ✅ |
| GET | `.../files/{fileUuid}` | ✅ | ✅ |
| GET | `.../files/{fileUuid}/content` | ✅ | ✅ |
| POST | `.../files` | ✅ PassShare 拡張 | ✅ |
| DELETE | `.../files/{fileUuid}` | ✅ PassShare 拡張 | ✅ |
| GET | `/health` | ✅ `app.js`（OpenAPI 拡張） | ✅ |
| GET | `/health/db` | ✅ `app.js` | ✅ |
| GET | `/metrics` | ✅ `app.js`（PassShare 拡張） | Should |
| POST | `/vaults/{vaultUuid}/imports/1pux` | ✅ PassShare 拡張 | Should |

## 品質ギャップ（Must 解消済み / Should 残）

| 領域 | 内容 | 分類 | Issue |
|------|------|------|-------|
| OpenAPI スキーマ詳細 | Vault/Item requestBody・401/403 レスポンス未定義 | Should | — |
| category 検証 | API 層で SCREAMING_SNAKE_CASE 7 種を検証 | Must | #53 |
| 1PUX インポート | サーバー側 ZIP 解析 + Item 作成 | Should | #54 |
| SDK 型自動生成 | connect-api.yaml → TypeScript | Should | #55 |
| 監視ダッシュボード | Railway アラート + `/metrics` | Should | #57 |

## エラーコードカバレッジ

| コード | 意味 | テスト |
|--------|------|--------|
| PS009 | ID 形式不正 | ✅ |
| PS011 | Bearer 無効 | ✅ |
| PS012 | Vault 未検出 | ✅ |
| PS013 | JSON Patch 不正 | ✅ |
| PS014 | ファイル未検出 | ✅ |
| PS015 | PATCH Content-Type 不正 | ✅ |
| PS016 | パスワードボックス ACL 拒否 | ✅ |
| PS017 | 1PUX 不正 | ✅ (#54) |

## 結論

Must ギャップは本 PR（#51–#59 実装）で **0** に解消する。Should 項目（完全 OpenAPI スキーマ、外部 APM ダッシュボード）は Epic 完了後も P1 として継続可能。
