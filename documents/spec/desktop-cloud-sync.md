# Desktop クラウド同期（Should #76 / Epic #35）

> 最終更新: 2026-05-30  
> ADR: [007-sync-migration-architecture.md](../adr/007-sync-migration-architecture.md)  
> 親 Epic: [#35](https://github.com/AutoDevJapan/PassShare/issues/35) / [#32](https://github.com/AutoDevJapan/PassShare/issues/32)

## 方針

- Desktop は **ローカル `.pbox` ファースト**。クラウド同期は **オプション**（設定で有効化）。
- マスターパスワードは端末内に保持し、Connect API 認証は **Web セッション + Connect トークン**（L2）を使用する。
- 双方向同期・競合解決は [sync-migration.md](./sync-migration.md) / ADR 007 に準拠。

## UI（`CloudSyncSettings`）

| 要素 | 説明 |
|------|------|
| 同期有効化トグル | オプション同期の ON/OFF |
| API URL / 認証 / vaultId | Connect API 接続情報 |
| 同期を確認 | 競合検出のみ |
| **同期を実行** | push + pull（#99） |
| 競合解決 | ローカル優先 / クラウド優先（#103） |
| 1PUX インポート | クラウド vault へ投入（#101） |

## 競合検出

同一 `item.id` が両方に存在し、内容フィンガープリント（title / category / フィールド / tags）が異なる場合に競合。

### マージベース追跡（#382）

片側編集を自動同期するため、同期成功時に item ごとの **base revision**（Connect `Item.version`）をローカルに保存する（desktop は `localStorage` の `passshare.desktop.cloudSync.baseRevisions`）。

- Connect API の revision はサーバ単調増加のため、**remote revision が base から不変**であれば remote は base のままだと証明できる。内容が相違していればそれは **local 単独編集**であり、自動 push（`overwriteRemote`）する。
- **remote revision が base より進んでいる**場合は remote が変化しており、local も変化しているか確証が持てないため、保守的に conflict とする（データ損失を避ける）。
- base 未記録の item は従来どおり `compareItemRecency` にフォールバックする。
- **base fingerprint は平文の秘密情報を含む**ため、暗号化境界（`.pbox`）の外（`localStorage` 等）へは絶対に保存しない。desktop が保存するのは非機微な revision 整数のみ。純関数側（`resolveWithBase`）は fingerprint 付き base もサポートするが、これはテスト／将来の vault 保持型コンシューマ用途に限る。

## 受入基準

- [x] ADR 007 に沿った双方向同期 MVP
- [x] 競合検出 + 手動解決 UI
- [x] 1PUX インポート（クラウド経由）

## 自動テスト対応表（#211）

Quality Gate `docker-e2e`（`backend/test/cloud-sync.integration.test.js`）が Desktop `cloud-sync.ts` と同じ Auth + Connect HTTP フローを検証する。

| 受入基準 / シナリオ | テスト | 検証内容 |
|---------------------|--------|----------|
| 双方向同期 MVP（push） | `pushes local-only items...` | ローカルのみの item を Connect API へ POST |
| 双方向同期 MVP（pull） | `pushes local-only items...` | リモートのみの item を `onPull` でローカル反映 |
| 競合検出 | `detects conflicts...` | 同一 id・異なるフィンガープリントで `checkSyncConflicts` が 1 件 |
| 競合解決（ローカル優先） | `detects conflicts...` | `resolveConflictKeepLocal` で remote が local に一致 |
| 競合解決（クラウド優先） | `detects conflicts...` | `resolveConflictKeepRemote` で `onPull` に remote が渡る |
| マージベース追跡（#382） | `auto-pushes a local one-sided edit...` | 初回同期で base revision 記録 → local 単独編集を自動 push（conflict 0 件） |
| Auth + Connect トークン | `before` + 各テスト | signup → session cookie → `/api/auth/connect-token` → Bearer |

実装ミラー: `backend/test/helpers/desktop-cloud-sync-flow.js`（`apps/desktop/src/lib/cloud-sync.ts` 相当）
