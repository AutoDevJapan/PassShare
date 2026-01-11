# PassShare

<p align="center">
  <img src="logo.png" alt="PassShare Logo" width="120" height="120">
</p>

<p align="center">
  <strong>チームと個人のためのセキュアなパスワードマネージャー</strong>
</p>

<p align="center">
  <a href="https://pass-share.bm1314.net">公式サイト</a> •
  <a href="https://pass-share.bm1314.net/docs">ドキュメント</a> •
  <a href="https://pass-share.bm1314.net/download">ダウンロード</a>
</p>

---

**© 2026 株式会社BM1314. All rights reserved.**

## PassShare とは？

PassShare は、**GPG/Age 暗号化**と **Git 同期**を使った安全なパスワードマネージャーです。

- 🔐 業界標準の暗号化でパスワードを保護
- 🔄 Git で自動バックアップ・複数デバイス間で同期
- 👥 チームメンバーと安全にパスワードを共有
- 🔧 既存の pass/gopass ストアをそのまま使用可能

## インストール

### Python（推奨）

```bash
pip install passshare
```

### Node.js

```bash
npm install -g passshare
```

### TypeScript ライブラリ

```bash
npm install @passshare/core
```

## はじめ方

### 0. GPG キーを確認（初めての方）

PassShare は GPG キーを使ってパスワードを暗号化します。まず、利用可能な GPG キーを確認しましょう。

```bash
# 利用可能な GPG キーを一覧表示
gpg --list-keys --keyid-format LONG
```

出力例：
```
pub   ed25519/ABCD1234EFGH5678 2024-01-01 [SC]
      1234567890ABCDEF1234567890ABCDEF12345678
uid           [ultimate] Your Name <your.email@example.com>
```

上記の場合、以下のいずれかを GPG キー ID として使用できます：
- `ABCD1234EFGH5678`（短い形式）
- `1234567890ABCDEF1234567890ABCDEF12345678`（フィンガープリント）
- `your.email@example.com`（メールアドレス）

> **GPG キーがない場合：**
> ```bash
> gpg --full-generate-key
> ```
> 画面の指示に従ってキーを作成してください。

### 1. ストアを初期化

```bash
# GPG キー ID で初期化
passshare init ABCD1234EFGH5678

# または、メールアドレスで指定
passshare init your.email@example.com
```

### 2. パスワードを追加

```bash
# 対話形式で入力
passshare insert email/gmail

# ワンライナーで追加
echo "mypassword" | passshare insert -e email/gmail
```

### 3. パスワードを表示

```bash
# ターミナルに表示
passshare show email/gmail

# クリップボードにコピー（45秒後に自動クリア）
passshare show -c email/gmail
```

### 4. パスワードを自動生成

```bash
# 24文字のパスワードを生成
passshare generate website/example

# 長さを指定
passshare generate website/example 32

# クリップボードにコピー
passshare generate -c website/example
```

## 基本コマンド

| コマンド | 説明 | 例 |
|----------|------|-----|
| `init` | ストアを初期化 | `passshare init KEY_ID` |
| `show` | パスワードを表示 | `passshare show email/gmail` |
| `insert` | パスワードを追加 | `passshare insert email/gmail` |
| `edit` | パスワードを編集 | `passshare edit email/gmail` |
| `generate` | パスワードを生成 | `passshare generate site/name 24` |
| `rm` | パスワードを削除 | `passshare rm email/gmail` |
| `ls` | 一覧表示 | `passshare ls` |
| `find` | 検索 | `passshare find gmail` |
| `cp` | コピー | `passshare cp old/path new/path` |
| `mv` | 移動 | `passshare mv old/path new/path` |
| `sync` | リモートと同期 | `passshare sync` |

## パスワードの構造

PassShare のパスワードエントリは以下の形式です：

```
パスワード（1行目）
---
username: user@example.com
url: https://example.com
otp: otpauth://totp/Example:user?secret=XXXX
---
追加のメモをここに記述
```

### キー・バリュー形式

```bash
# ユーザー名を取得
passshare show -k username email/gmail

# URL を取得
passshare show -k url email/gmail
```

## OTP（ワンタイムパスワード）

### OTP を追加

```bash
# OTP URI を含むエントリを編集
passshare edit email/gmail

# エディタで以下を追加：
# otp: otpauth://totp/Gmail:user?secret=YOURSECRET&issuer=Google
```

### OTP コードを表示

```bash
passshare otp email/gmail
```

## チームでの共有

### 受信者を追加

```bash
# チームメンバーの GPG キーを追加
passshare recipients add TEAMMATE_KEY_ID
```

### 受信者一覧

```bash
passshare recipients
```

### マウントポイント（複数ストア）

```bash
# 仕事用ストアをマウント
passshare mounts add work /path/to/work-store

# マウント一覧
passshare mounts

# マウントされたストアのパスワードを表示
passshare show work/database/production
```

## Git 同期

### 初期設定

```bash
# リモートリポジトリを設定（初回のみ）
cd ~/.password-store
git remote add origin git@github.com:yourname/passwords.git
```

### 同期

```bash
# プッシュ＆プル
passshare sync
```

## プログラムから使う

### Python

```python
from passshare import Gopass

# ストアに接続
gopass = Gopass()

# パスワードを取得
secret = gopass.get("email/gmail")
print(secret.password)
print(secret.get("username"))

# パスワードを保存
from passshare import Secret
new_secret = Secret(
    password="newpassword123",
    data={"username": "user@example.com", "url": "https://gmail.com"}
)
gopass.set("email/gmail", new_secret)

# パスワードを生成
password = gopass.generate("website/new", length=24)
```

### TypeScript

```typescript
import { Gopass, Secret } from '@passshare/core';

// ストアに接続
const gopass = new Gopass();

// パスワードを取得
const secret = await gopass.get('email/gmail');
console.log(secret.password);
console.log(secret.get('username'));

// パスワードを保存
const newSecret = new Secret({
  password: 'newpassword123',
  data: new Map([
    ['username', 'user@example.com'],
    ['url', 'https://gmail.com'],
  ]),
});
await gopass.set('email/gmail', newSecret);
```

## セキュリティ Tips

1. **GPG キーを安全に保管** - 秘密鍵は絶対に共有しない
2. **強力なパスフレーズ** - GPG キーのパスフレーズは長く複雑に
3. **定期的な同期** - `passshare sync` で常に最新状態を維持
4. **クリップボード自動クリア** - `-c` オプションで45秒後に自動消去
5. **パスワード監査** - `passshare audit` で弱いパスワードをチェック

## トラブルシューティング

### GPG キーが見つからない

```bash
# 利用可能なキーを一覧
gpg --list-keys

# キーを生成
gpg --full-generate-key
```

### パーミッションエラー

```bash
# ストアのパーミッションを修正
chmod -R 700 ~/.password-store
```

### Git 同期エラー

```bash
# 手動でリセット
cd ~/.password-store
git fetch origin
git reset --hard origin/main
```

## 対応プラットフォーム

| プラットフォーム | 状態 |
|------------------|------|
| 🌐 Web（PC/タブレット/スマホ） | ✅ |
| 🖥️ Windows / Mac（デスクトップアプリ） | ✅ |
| 📱 iOS / Android（モバイルアプリ） | ✅ |
| 💻 CLI（コマンドライン） | ✅ |

## ヘルプ

```bash
# コマンド一覧
passshare --help

# 各コマンドのヘルプ
passshare show --help
passshare generate --help
```

## リンク

- [公式サイト](https://pass-share.bm1314.net)
- [ドキュメント](https://pass-share.bm1314.net/docs)
- [GitHub](https://github.com/bm1314/passshare)
- [問い合わせ](mailto:info@bm1314.co.jp)

## ライセンス

MIT License - [LICENSE](LICENSE) を参照

---

**株式会社BM1314**  
https://bm1314.co.jp
