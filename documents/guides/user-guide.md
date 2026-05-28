# PassShare ユーザーガイド

> Issue [#111](https://github.com/AutoDevJapan/PassShare/issues/111)  
> Web: `/docs/user-guide`  
> 最終更新: 2026-05-28

## 概要

初回セットアップから日常利用まで、PassShare のパスワードボックス操作を説明します。

## 1. アカウント作成

Web ポータル（`/app/signup`）または Desktop アプリからアカウントを作成します。マスターパスワードはサーバーに送信されません。

## 2. パスワードボックスを開く

- **Desktop:** `.pbox` ファイルを選択し、マスターパスワードで解錠
- **Web:** ログイン後、Connect API 経由でクラウド上のパスワードボックスにアクセス

## 3. ログイン情報の管理

| クライアント | 操作 |
|-------------|------|
| Web | `/app/vaults` → パスワードボックス選択 → CRUD |
| Desktop | 項目追加・検索・コピー（クリップボード自動消去） |
| Mobile / Extension | Connect API 経由 |

## 4. クラウド同期（Desktop）

設定 → クラウド同期で push / pull。競合時はローカル優先またはクラウド優先を選択。

## 5. データ移行

1Password から 1PUX インポートまたは CSV エクスポート → PassShare インポート。

## 関連

- [extension-install.md](./extension-install.md)
- [faq.md](./faq.md)
- [desktop-ui.md](../spec/desktop-ui.md)
