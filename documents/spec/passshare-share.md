# PassShare Share（チーム共有）

> Issue [#100](https://github.com/AutoDevJapan/PassShare/issues/100)  
> ADR: [004-auth-authorization-model.md](../adr/004-auth-authorization-model.md)

## 概要

パスワードボックスを、管理者が本人を確認した他の PassShare アカウントと共有する。
共有先は Connect API 経由で項目の閲覧・編集が可能（`member` ロール）。
メールアドレスを名乗って登録したことや、招待一覧に表示されたことだけでは参加できない。

## ロール

| ロール | 権限 |
|--------|------|
| `owner` | メンバー招待・削除、ロール変更、ボックス削除（将来） |
| `member` | Connect API 経由の項目 CRUD（`/v1` スコープ内） |

`viewer` は v2.1 以降。

## API（`/api/auth`）

### ボックスメンバー（要セッション）

| Method | Path | 権限 | 説明 |
|--------|------|------|------|
| GET | `/vaults/:vaultId/members` | owner / 確認済み member | メンバー一覧（`identityConfirmed` を含む） |
| PATCH | `/vaults/:vaultId/members/:userId` | owner | ロール変更（`member` のみ） |
| DELETE | `/vaults/:vaultId/members/:userId` | owner | メンバー削除 |

### 招待（要セッション + CSRF）

| Method | Path | 権限 | 説明 |
|--------|------|------|------|
| POST | `/vaults/:vaultId/invitations` | owner | `{ email, role?: "member" }` で招待作成。`confirmationCode` を一度だけ返す |
| GET | `/vaults/:vaultId/invitations` | owner | pending 招待一覧。コードと照合値を返さない |
| DELETE | `/vaults/:vaultId/invitations/:invitationId` | owner | 招待取消 |

### 受信側招待

| Method | Path | 説明 |
|--------|------|------|
| GET | `/invitations` | ログインユーザー宛 pending 一覧。コードと照合値を返さない |
| POST | `/invitations/:id/accept` | `{ confirmationCode }` を照合し、本人確認済みの所属を追加または更新 |
| POST | `/invitations/:id/decline` | 辞退 |

招待 TTL: **7 日**。未登録メール宛の招待は、アカウント作成後に同じメールで `/invitations` に表示される。

Web の変更要求にはセッション Cookie と CSRF Cookie・ヘッダーが必要。
モバイル・拡張の認証方式は [auth-api.md](./auth-api.md) に従う。

確認コードは256bitの乱数を43文字のbase64urlで表す。所有者は招待の作成応答でだけ取得できる。
DBにはSHA-256の照合値を保存する。管理者が普段から使っている社内の連絡先・対面・
本人確認済みの通話など、独立した経路で本人に渡す。
参加希望者が入力した連絡先へ、そのまま送り返してはならない。
コードをURL、ログ、問い合わせへ記録しない。

コードなし・誤コード・別アカウント・権限を失った招待者は参加を拒否する。
期限切れは参加できず、所有者が新しいコードで招待し直す。
作成応答やコードを失った場合は取消して作り直す。取消・辞退・承諾済みの招待は再利用できない。
同時承諾は1件だけを確定する。取消と承諾が競合した場合は先に確定した操作だけを有効とする。

以前から所属していた通常メンバーにも本人確認が必要。
未確認の所属・項目・添付を削除せず、共有の読み書きを止める。
所有者が同じアカウントを招待し直し、本人が新しいコードで確認すると、元の共有データを使える。
移行と配備の手順は [sharing-identity-migration.md](./sharing-identity-migration.md) に従う。

## Web UI

| パス | 内容 |
|------|------|
| `/app/vaults/:vaultId/share` | メンバー一覧・本人確認待ち表示・招待フォーム・コードの一度だけの表示・招待取消 |
| `/app/invitations` | 確認コード入力による参加 / 辞退 |

項目画面（`/app/vaults/:vaultId/items`）から「共有」リンクで遷移。

2026-10-05T14:58:59.937000+00:00（同日23:58:59 JST）、オーナー投稿
`1556682123245658244` の「<@1554269962229649478> a」は、今の見た目を保ち、
コード表示と入力を追加する画像案への承認として反映した。
対象は [共有の本人確認画面の質問](https://discord.com/channels/1552944707464597524/1556681919469457471)。
この回答をパスワード変更画面、販売開始、公開、支出の承認へ拡大しない。

## 受入基準（Issue #100）

```gherkin
Given パスワードボックスの owner
When 他ユーザーのメールで招待する
Then 相手の /app/invitations に pending が表示される

Given 招待を受けた member
When 管理者から独立した経路で受け取った正しいコードで承諾する
Then Connect API で当該ボックスの項目にアクセスできる

Given 同じメールを名乗って登録したアカウント
When コードなしまたは誤コードで承諾する
Then 共有に参加できず、所属と既存項目・添付は変わらない

Given 正しいコードを知る別アカウント
When 他人宛の招待を承諾する
Then 共有に参加できず、その本人の後続の承諾は妨げない

Given owner
When メンバーを削除する
Then 当該ユーザーの発行済み Connect トークンも再発行したトークンも共有へアクセスできない
```

実APIの受入はRustの `backend/native/src/bin/acceptance/share.rs` と
`web_share.rs` で行う。後者はWebのCookie・CSRF経路で、作成・取消・再招待・
一覧からの秘密漏えい防止・不正承諾後の所属保持・正しい参加・除名後の拒否を検査する。
Memory、PostgreSQL、配布用Dockerイメージを同じ受入で照合する。
これらはHTTPの検査であり、画面操作・全クライアント・本番配備の検証とは区別する。

## 参照

- [auth-api.md](./auth-api.md)
- [sync-migration.md](./sync-migration.md)
