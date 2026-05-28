# Desktop クラウド同期（Should #76 / Epic #35）

> 最終更新: 2026-05-28  
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

## 受入基準

- [x] ADR 007 に沿った双方向同期 MVP
- [x] 競合検出 + 手動解決 UI
- [x] 1PUX インポート（クラウド経由）
