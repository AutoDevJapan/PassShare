# Sync & Migration (Epic #35)

> 最終更新: 2026-05-28  
> ADR: [007-sync-migration-architecture.md](../adr/007-sync-migration-architecture.md)

## 同期 MVP (#99)

### フロー

1. Desktop でクラウド同期を有効化し API / vaultId を設定
2. **同期を実行** — push（ローカルのみ）+ pull（クラウドのみ）を一括実行
3. 競合があれば **競合解決 UI** で「ローカルを優先」または「クラウドを優先」

### 受入基準

- [x] 2 デバイス間 sync smoke（ローカル追加 → push → Web 確認）
- [x] 競合検出 + 手動解決（#103）

## 移行 (#101 / #102)

| 操作 | Desktop | Web |
|------|---------|-----|
| 1Password CSV インポート | `.pbox` 直書き | Connect API 逐次 create |
| 1PUX インポート | Connect API | Connect API |
| 1Password CSV エクスポート | `.pbox` → ファイル保存 | ブラウザダウンロード |

### 受入基準

- [x] Desktop / Web 1PUX インポート UI
- [x] CSV エクスポート（1Password 互換列）

## 後続（Epic 外）

- PassShare Share（チーム共有）— [#100](https://github.com/AutoDevJapan/PassShare/issues/100) v2.1
- バックグラウンド自動同期
- 1PUX エクスポート
