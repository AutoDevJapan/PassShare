# Desktop クラウド同期（Should #76）

> 最終更新: 2026-05-28  
> 親 Epic: [#32](https://github.com/AutoDevJapan/PassShare/issues/32) / Issue [#76](https://github.com/AutoDevJapan/PassShare/issues/76)

## 方針（ADR 003 / 004 準拠）

- Desktop は **ローカル `.pbox` ファースト**。クラウド同期は **オプション**（設定で有効化）。
- マスターパスワードは端末内に保持し、Connect API 認証は **Web セッション + Connect トークン**（L2）を使用する。
- 完全な双方向マージは Epic [#35](https://github.com/AutoDevJapan/PassShare/issues/35) で詳細化。本 Issue では **競合検出 + 通知** を MVP とする。

## UI

| 要素 | 場所 |
|------|------|
| 同期有効化トグル | `CloudSyncSettings`（MainPanel） |
| API URL / 認証 / vaultId | 同上 |
| 競合一覧 | 「同期を確認」実行後 |

## 競合検出

同一 `item.id` がローカルと Connect API の両方に存在し、`title` または `category` が異なる場合に競合とみなす。

## 受入基準

- [x] ADR 003/004 に沿ったオプション同期 UI
- [x] 競合検出時にユーザーへ通知（リスト表示）

## 後続（Epic #35）

- 双方向マージ / last-write-wins / 手動解決フロー
