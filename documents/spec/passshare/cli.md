# PassShare CLI仕様

## 概要

このドキュメントはPassShareのCLIインターフェース仕様を定義します。

**設計原則:**
- pass/gopass形式と互換（既存ストアをそのまま利用可能）
- 直感的なコマンド体系
- スクリプト/自動化に適したオプション設計

## グローバルオプション

```
--yes, -y          確認プロンプトをスキップ
--clip, -c         クリップボードにコピー
--alsoclip, -C     表示しつつクリップボードにもコピー
--password, -o     パスワード（1行目）のみ表示
--force, -f        強制実行
--recursive, -r    再帰的に処理
--verbose, -v      詳細出力
--help, -h         ヘルプ表示
--version          バージョン表示
```

## コマンド一覧

### ストア管理

#### `passshare` / `passshare show [name]`
シークレットの表示（デフォルトコマンド）

```bash
# シークレット全体を表示
passshare foo/bar

# パスワードのみ表示
passshare -o foo/bar

# クリップボードにコピー
passshare -c foo/bar

# 特定のキーの値を表示
passshare foo/bar key1

# REPLモード（引数なし）
passshare
```

**オプション:**
- `-c, --clip` - クリップボードにコピー
- `-C, --alsoclip` - 表示しつつクリップボードにもコピー
- `-o, --password` - パスワード（1行目）のみ
- `-n, --noparsing` - パースせずにraw表示
- `--chars` - 文字列のみ表示
- `-r, --revision` - 特定のリビジョンを表示

---

#### `passshare init [gpg-id...]`
新規ストアの初期化

```bash
# デフォルトストアを初期化
passshare init 0xDEADBEEF

# 特定パスに初期化
passshare init --store work 0xDEADBEEF

# 暗号化バックエンドを指定
passshare init --crypto age
```

**オプション:**
- `-s, --store` - ストア名（マウントポイント用）
- `-p, --path` - ストアのパス
- `--crypto` - 暗号化バックエンド（gpg, age）
- `--storage` - ストレージバックエンド（gitfs, fs）

---

#### `passshare setup`
インタラクティブセットアップウィザード

```bash
passshare setup
```

**オプション:**
- `--remote` - リモートリポジトリURL
- `--alias` - ストアのエイリアス
- `--create` - 新規作成モード
- `--name` - GPG鍵の名前
- `--email` - GPG鍵のメール

---

#### `passshare clone <repo> [mount]`
リモートストアのクローン

```bash
# デフォルトストアとしてクローン
passshare clone git@github.com:user/passwords.git

# マウントポイントを指定
passshare clone git@github.com:user/work-passwords.git work

# 暗号化バックエンドを指定
passshare clone --crypto age git@github.com:user/passwords.git
```

**オプション:**
- `--path` - クローン先のパス
- `--crypto` - 暗号化バックエンド
- `--check-keys` - 鍵の検証

---

### シークレット操作

#### `passshare insert <name>`
シークレットの追加

```bash
# インタラクティブ入力
passshare insert foo/bar

# エコーなし（パスワード用）
passshare insert foo/bar

# 複数行入力
passshare insert -m foo/bar

# パイプから入力
echo "password" | passshare insert foo/bar
```

**オプション:**
- `-e, --echo` - 入力をエコー
- `-m, --multiline` - 複数行モード
- `-f, --force` - 上書き強制
- `-a, --append` - 追記モード

---

#### `passshare edit <name>`
シークレットの編集

```bash
passshare edit foo/bar
```

**オプション:**
- `-e, --editor` - エディタを指定
- `-c, --create` - 存在しない場合は作成

---

#### `passshare delete <name>` / `passshare rm <name>`
シークレットの削除

```bash
# 単一シークレットを削除
passshare delete foo/bar

# フォルダを再帰的に削除
passshare delete -r foo/

# 強制削除（確認なし）
passshare delete -f foo/bar
```

**オプション:**
- `-f, --force` - 確認をスキップ
- `-r, --recursive` - 再帰的に削除

---

#### `passshare generate <name> [length]`
パスワード生成

```bash
# 24文字のパスワードを生成
passshare generate foo/bar 24

# 記号なし
passshare generate -n foo/bar 16

# クリップボードにコピー
passshare generate -c foo/bar

# 既存を上書き
passshare generate -f foo/bar
```

**オプション:**
- `-c, --clip` - クリップボードにコピー
- `-p, --print` - 表示
- `-f, --force` - 上書き強制
- `-n, --no-symbols` - 記号を除外
- `-s, --symbols` - 記号を含める
- `--strict` - 厳格モード
- `-x, --xkcd` - XKCD形式（単語ベース）
- `--sep` - 単語の区切り文字
- `--lang` - 言語（xkcd用）

---

#### `passshare create`
インタラクティブなシークレット作成

```bash
passshare create
```

**オプション:**
- `-s, --store` - ストアを指定

---

### ストア操作

#### `passshare list [folder]` / `passshare ls [folder]`
シークレット一覧

```bash
# 全シークレット一覧
passshare list

# 特定フォルダ
passshare list foo/

# フラット表示
passshare list -f
```

**オプション:**
- `-l, --limit` - 表示数制限
- `-f, --flat` - フラット表示
- `-s, --strip-prefix` - プレフィックスを除去

---

#### `passshare find <pattern>` / `passshare search <pattern>`
シークレット名の検索

```bash
passshare find github
```

**オプション:**
- `-c, --clip` - 結果をクリップボードにコピー
- `-u, --unsafe` - 安全でない検索を許可

---

#### `passshare grep <pattern>`
シークレット内容の検索

```bash
passshare grep "api.example.com"
```

**オプション:**
- `-n, --name` - 名前も検索

---

#### `passshare copy <from> <to>` / `passshare cp <from> <to>`
シークレットのコピー

```bash
passshare copy foo/bar foo/baz
```

**オプション:**
- `-f, --force` - 上書き強制

---

#### `passshare move <from> <to>` / `passshare mv <from> <to>`
シークレットの移動

```bash
passshare move foo/bar baz/bar
```

**オプション:**
- `-f, --force` - 上書き強制

---

### 同期

#### `passshare sync`
リモートとの同期

```bash
# 全ストアを同期
passshare sync

# 特定ストアのみ
passshare sync -s work
```

**オプション:**
- `-s, --store` - ストアを指定

---

#### `passshare git <command>`
Git操作（内部用）

```bash
passshare git push
passshare git pull
passshare git status
```

---

### マウントポイント

#### `passshare mounts`
マウントポイントの管理

```bash
# 一覧表示
passshare mounts

# マウントを追加
passshare mounts add work ~/.local/share/gopass/stores/work

# マウントを削除
passshare mounts remove work
```

**サブコマンド:**
- `add <alias> <path>` - マウントを追加
- `remove <alias>` - マウントを削除

---

### 受信者管理

#### `passshare recipients`
受信者（GPG鍵）の管理

```bash
# 一覧表示
passshare recipients

# 受信者を追加
passshare recipients add 0xDEADBEEF

# 受信者を削除
passshare recipients remove 0xDEADBEEF

# 特定ストアの受信者
passshare recipients -s work
```

**サブコマンド:**
- `add [gpg-id]` - 受信者を追加
- `remove [gpg-id]` - 受信者を削除

**オプション:**
- `-s, --store` - ストアを指定

---

### 設定

#### `passshare config`
設定の管理

```bash
# 全設定を表示
passshare config

# 特定の設定を表示
passshare config autoclip

# 設定を変更
passshare config autoclip true
```

**オプション:**
- `-s, --store` - ストア固有の設定

---

### その他

#### `passshare audit`
パスワード監査

```bash
# 全シークレットを監査
passshare audit

# 特定フォルダ
passshare audit foo/
```

**オプション:**
- `--full` - 詳細監査
- `--hibp` - Have I Been Pwnedチェック

---

#### `passshare otp [name]`
OTP（ワンタイムパスワード）

```bash
# OTPコードを生成
passshare otp foo/bar

# クリップボードにコピー
passshare otp -c foo/bar

# QRコードを表示
passshare otp -q foo/bar
```

**オプション:**
- `-c, --clip` - クリップボードにコピー
- `-q, --qr` - QRコードを表示
- `-s, --snip` - 画面のQRコードを読み取り

---

#### `passshare env <name> <command...>`
環境変数としてシークレットを注入

```bash
passshare env foo/bar -- some-command
```

---

#### `passshare templates`
テンプレート管理

```bash
# 一覧表示
passshare templates

# テンプレートを表示
passshare templates show foo

# テンプレートを編集
passshare templates edit foo

# テンプレートを削除
passshare templates remove foo
```

---

#### `passshare convert`
バックエンド変換

```bash
# GPGからAgeに変換
passshare convert --crypto age

# ストレージバックエンド変換
passshare convert --storage fs
```

---

#### `passshare fsck`
ストア整合性チェック

```bash
passshare fsck
```

**オプション:**
- `--decrypt` - 全シークレットを復号してチェック

---

#### `passshare cat <name>`
シークレットをstdoutに出力（パースなし）

```bash
passshare cat foo/bar
```

---

#### `passshare history <name>`
シークレットの履歴表示

```bash
passshare history foo/bar
```

**オプション:**
- `-p, --password` - パスワード履歴も表示

---

#### `passshare link <from> <to>`
シンボリックリンク作成

```bash
passshare link foo/bar foo/alias
```

---

#### `passshare process <template-file>`
テンプレートファイルを処理

```bash
passshare process config.tpl > config.ini
```

---

#### `passshare pwgen [length]`
スタンドアロンパスワード生成

```bash
# デフォルト24文字
passshare pwgen

# 16文字
passshare pwgen 16

# XKCD形式
passshare pwgen -x
```

**オプション:**
- `-n, --no-symbols` - 記号を除外
- `-s, --symbols` - 記号を含める
- `-x, --xkcd` - XKCD形式
- `--one-per-line` - 1行1パスワード

---

#### `passshare update`
自己アップデート

```bash
passshare update
```

---

#### `passshare version`
バージョン表示

```bash
passshare version
```

---

#### `passshare completion <shell>`
シェル補完スクリプト生成

```bash
passshare completion bash
passshare completion zsh
passshare completion fish
passshare completion powershell
```

## 終了コード

| コード | 意味 |
|--------|------|
| 0 | 成功 |
| 1 | 一般エラー |
| 2 | 使用方法エラー |
| 10 | シークレットが見つからない |
| 11 | 復号エラー |
| 12 | 暗号化エラー |
| 20 | Git操作エラー |
| 30 | 設定エラー |

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `GOPASS_CONFIG` | 設定ファイルパス | `~/.config/gopass/config` |
| `PASSWORD_STORE_DIR` | デフォルトストアパス | `~/.local/share/gopass/stores/root` |
| `EDITOR` | エディタ | `vim` |
| `GOPASS_HOMEDIR` | ホームディレクトリ（テスト用） | `~` |
| `GOPASS_NO_AUTOSYNC` | 自動同期を無効化 | - |
| `GOPASS_CLIP_TIME` | クリップボード保持時間（秒） | `45` |
| `GOPASS_GPG_BINARY` | GPGバイナリパス | `gpg` |
| `GOPASS_AGE_BINARY` | Ageバイナリパス | `age` |
