# PassShare 機能仕様

## 概要

このドキュメントはPassShareが実装する全機能の詳細仕様を定義します。

**互換性**: pass/gopass形式のストアと完全互換。既存ストアをそのまま利用可能。

## 1. ストア管理

### 1.1 ストア初期化（init）

**目的:** 新しいパスワードストアを初期化する

**前提条件:**
- GPGまたはAge鍵が利用可能
- 書き込み権限のあるディレクトリ

**処理フロー:**
1. ストアディレクトリを作成
2. `.gpg-id`ファイルを作成（受信者ID一覧）
3. ストレージバックエンドを初期化（git init等）
4. 設定ファイルを更新

**成功条件:**
- ストアディレクトリが作成される
- `.gpg-id`が正しいGPG鍵IDを含む
- Gitリポジトリが初期化される（gitfsの場合）

---

### 1.2 セットアップウィザード（setup）

**目的:** インタラクティブな初期設定

**処理フロー:**
1. 既存のGPG鍵を一覧表示
2. 鍵を選択または新規作成
3. Gitリモートを設定（オプション）
4. ストアを初期化

**UI仕様:**
```
🌟 Welcome to PassShare! 🌟
Initializing a new password store ...

🎮 Please select a private key for encrypting secrets:
[0] gpg - 0xFEEDBEEF - John Doe <john.doe@example.org>
Please enter the number of a key (0-12, [q]uit) (q to abort) [0]: 

❓ Do you want to add a git remote? [y/N/q]: 
```

---

### 1.3 クローン（clone）

**目的:** リモートストアをローカルにクローン

**前提条件:**
- Git SSHまたはHTTPS認証が設定済み
- 対応するGPG鍵がローカルに存在

**処理フロー:**
1. Gitリポジトリをクローン
2. `.gpg-id`を読み込み、鍵の存在を確認
3. 設定ファイルにマウントポイントを追加

---

### 1.4 マウントポイント（mounts）

**目的:** 複数のストアを統一的な名前空間で管理

**データ構造:**
```yaml
mounts:
  work: ~/.local/share/gopass/stores/work
  personal: ~/.local/share/gopass/stores/personal
```

**パス解決:**
- `work/email` → `~/.local/share/gopass/stores/work/email.gpg`
- `personal/bank` → `~/.local/share/gopass/stores/personal/bank.gpg`
- `github` → `~/.local/share/gopass/stores/root/github.gpg`

---

## 2. シークレット操作

### 2.1 シークレット表示（show）

**目的:** 暗号化されたシークレットを復号して表示

**処理フロー:**
1. シークレットパスを解決
2. ストレージバックエンドからファイルを読み込み
3. 暗号化バックエンドで復号
4. コンテンツをパース
5. 出力（表示/クリップボード）

**出力形式:**
```
# 全体表示
password123
---
username: john@example.com
url: https://example.com
---
Additional notes here

# パスワードのみ (-o)
password123

# 特定のキー
passshare show foo/bar username
# → john@example.com
```

**クリップボード動作:**
- `-c`: パスワードをクリップボードにコピー（45秒後に自動クリア）
- `-C`: 表示しつつクリップボードにもコピー

---

### 2.2 シークレット追加（insert）

**目的:** 新しいシークレットを追加

**入力モード:**
1. **インタラクティブ（デフォルト）:** パスワードをプロンプトで入力
2. **マルチライン（-m）:** 複数行をEOFまで入力
3. **パイプ:** stdinからの入力

**処理フロー:**
1. 入力を受け取る
2. 暗号化バックエンドで暗号化
3. ストレージバックエンドでファイルを書き込み
4. Gitコミット（gitfsの場合）

---

### 2.3 シークレット編集（edit）

**目的:** 既存のシークレットを編集

**処理フロー:**
1. シークレットを復号
2. 一時ファイルに書き込み（セキュアなtmpfs推奨）
3. 外部エディタを起動
4. 編集完了後、再暗号化
5. 一時ファイルを安全に削除

**セキュリティ考慮:**
- 一時ファイルは`0600`権限
- 可能であればtmpfsを使用
- 編集後は安全に削除（shred等）

---

### 2.4 シークレット削除（delete/rm）

**目的:** シークレットを削除

**確認動作:**
- デフォルト: 削除前に確認
- `-f/--force`: 確認なしで削除
- `-r/--recursive`: フォルダを再帰的に削除

**処理フロー:**
1. シークレットの存在を確認
2. 確認プロンプト（-fでスキップ）
3. ストレージバックエンドでファイル削除
4. Gitコミット

---

### 2.5 パスワード生成（generate）

**目的:** ランダムなパスワードを生成

**生成アルゴリズム:**

1. **デフォルト（ランダム文字）:**
   - 使用文字: `a-zA-Z0-9!@#$%^&*()-_=+[]{};:,.<>?`
   - デフォルト長: 24文字
   - 暗号学的に安全な乱数を使用

2. **記号なし（-n）:**
   - 使用文字: `a-zA-Z0-9`

3. **XKCD形式（-x）:**
   - 4つのランダムな単語を組み合わせ
   - デフォルト区切り: `-`
   - 単語リスト: 言語別に用意

**エントロピー計算:**
```
エントロピー = log2(文字セットサイズ^長さ)
```

---

### 2.6 インタラクティブ作成（create）

**目的:** ウィザード形式でシークレットを作成

**UI仕様:**
```
🧪 Creating example/website ...
⚠ Password is empty. Do you want to generate a new one? [Y/n/q]: 

Website Login
Please enter the URL: https://example.com
Please enter the Login: john@example.com
```

---

## 3. ストア操作

### 3.1 一覧表示（list/ls）

**目的:** ストア内のシークレット一覧を表示

**出力形式（ツリー）:**
```
gopass
├── email/
│   ├── gmail
│   └── work
├── social/
│   ├── twitter
│   └── facebook
└── bank
```

**出力形式（フラット -f）:**
```
email/gmail
email/work
social/twitter
social/facebook
bank
```

---

### 3.2 検索（find/search）

**目的:** シークレット名でパターン検索

**マッチング:**
- 大文字小文字を無視
- 部分一致
- 複数マッチ時は一覧表示

---

### 3.3 内容検索（grep）

**目的:** シークレットの内容を検索

**処理:**
- 全シークレットを復号して検索
- マッチした行を表示

**出力形式:**
```
foo/bar:username: john@example.com
baz/qux:email: john@example.com
```

---

### 3.4 コピー/移動（copy/move）

**目的:** シークレットをコピーまたは移動

**ストア間操作:**
- 異なるストア間でのコピー/移動をサポート
- 受信者が異なる場合は再暗号化

---

## 4. 同期

### 4.1 同期（sync）

**目的:** リモートリポジトリと同期

**処理フロー:**
1. `git pull --rebase`
2. 受信者の再暗号化（必要な場合）
3. `git push`

**コンフリクト解決:**
- 自動マージを試行
- 失敗時はユーザーに通知

---

## 5. 受信者管理

### 5.1 受信者一覧（recipients）

**目的:** ストアにアクセスできるGPG鍵を管理

**データ構造（.gpg-id）:**
```
0xFEEDBEEF
0xDEADBEEF
0xCAFEBABE
```

### 5.2 受信者追加（recipients add）

**処理フロー:**
1. GPG鍵の存在を確認
2. `.gpg-id`に追加
3. 全シークレットを再暗号化
4. Gitコミット

### 5.3 受信者削除（recipients remove）

**処理フロー:**
1. `.gpg-id`から削除
2. 全シークレットを再暗号化（削除した鍵では復号不可に）
3. Gitコミット

---

## 6. OTPサポート

### 6.1 OTP生成（otp）

**目的:** TOTP/HOTPコードを生成

**シークレット内のOTP URI形式:**
```
otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example
```

**サポートするパラメータ:**
- `secret` - Base32エンコードされた共有シークレット
- `issuer` - 発行者
- `algorithm` - ハッシュアルゴリズム（SHA1, SHA256, SHA512）
- `digits` - 桁数（6または8）
- `period` - 更新間隔（デフォルト30秒）

---

## 7. 監査

### 7.1 パスワード監査（audit）

**目的:** パスワードの強度と重複をチェック

**チェック項目:**
- パスワード長
- 文字種の多様性
- 既知の弱いパスワード
- 重複パスワード
- Have I Been Pwned（オプション）

**出力形式:**
```
Auditing passwords...
foo/bar: weak password (too short)
baz/qux: password has been compromised (HIBP)
duplicate: foo/bar, baz/duplicate
```

---

## 8. テンプレート

### 8.1 テンプレート管理（templates）

**目的:** シークレット作成時のテンプレートを管理

**テンプレート形式:**
```yaml
---
priority: 1
name: Website Login
prefix: websites
name_from:
  - url
  - login
welcome: "🌐 Website Login Template"
---
url:
password:
login:
```

---

## 9. 環境変数注入

### 9.1 env

**目的:** シークレットを環境変数としてコマンドに注入

**動作:**
```bash
passshare env database/credentials -- ./my-app
# MY_APP_PASSWORD, MY_APP_USERNAME などが設定される
```

**変数命名規則:**
- キー名を大文字に変換
- ハイフンをアンダースコアに変換
- パスワード（1行目）は`PASSWORD`変数

---

## 10. ヒストリー

### 10.1 履歴表示（history）

**目的:** シークレットの変更履歴を表示

**出力形式:**
```
History for foo/bar:
  * 2024-01-10 14:30:00 - Updated password
  * 2024-01-05 09:15:00 - Initial creation
```

**リビジョン指定:**
```bash
passshare show -r abc1234 foo/bar
```

---

## 11. バックエンド変換

### 11.1 convert

**目的:** 暗号化/ストレージバックエンドを変換

**サポートする変換:**
- GPG → Age
- Age → GPG
- gitfs → fs
- fs → gitfs

**処理フロー:**
1. 全シークレットを復号
2. 新しいバックエンドで再暗号化
3. 古いファイルを削除
4. 設定を更新

---

## 12. 整合性チェック

### 12.1 fsck

**目的:** ストアの整合性をチェック

**チェック項目:**
- ファイル拡張子の正当性
- 復号可能性
- 受信者ファイルとの整合性
- Gitリポジトリの状態

---

## 13. Seed 自動検出（開発者向け）

**詳細仕様:** [seed-detection.md](./seed-detection.md)

### 13.1 概要

**目的:** 開発プロジェクト内のSeedデータ（テスト用認証情報）を自動検出し、Vault として一元管理する

**動作モード:**
- オンデマンド型（Vault表示時に毎回再スキャン）
- 読み取り専用（Seedファイルは変更しない）

### 13.2 対応形式

| 形式 | 拡張子 |
|------|--------|
| 環境変数 | `.env`, `.env.*` |
| JSON | `.json` |
| YAML | `.yaml`, `.yml` |
| CSV | `.csv` |
| JavaScript/TypeScript | `.js`, `.ts`, `.mjs` |
| Python | `.py` |

### 13.3 検出フィールド

- `email`, `password`, `username`, `token`, `api_key`, `secret` など

### 13.4 Vault 構造

```
📁 project-name       ← 1プロジェクト = 1 Vault
   📄 .env
   📄 seeds/users.json
   📄 config.yaml
```

### 13.5 UI/CLI

- **Desktop:** 「プロジェクトをスキャン」ボタン → Vault 一覧にプロジェクト単位で表示
- **CLI:** `passshare scan [directory]`
