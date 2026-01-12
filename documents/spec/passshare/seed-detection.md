# Seed 自動検出・Vault 登録機能

## Feature Spec（SDD x ATDD）

### 概要
- **Feature ID**: FR-013
- **名称**: Seed 自動検出・Vault 登録
- **目的**: 開発プロジェクト内の認証情報（Seedデータ）を自動検出し、Vault として一元管理する
- **スコープ**: Desktop App / CLI でのプロジェクトスキャン・登録・表示
- **非スコープ**: Seed ファイルへの書き戻し（読み取り専用）

---

### ユーザーストーリー

```
As a 開発者,
I want プロジェクト内の Seed データ（テスト用ログイン情報等）を自動検出して Vault に登録したい,
So that 複数プロジェクトの開発用認証情報を一箇所で管理・コピーできる.
```

---

## 機能仕様

### 1. コアコンセプト

| 項目 | 仕様 |
|------|------|
| **動作モード** | オンデマンド型（Vault 表示時に毎回再スキャン） |
| **データフロー** | Seed ファイル → 検出 → Vault 表示（読み取り専用） |
| **永続化** | 登録プロジェクトパスのみ永続化（認証情報はキャッシュしない） |
| **更新タイミング** | 「Vault を開く」操作時に自動で最新状態を反映 |

### 2. Vault 構造

```
📁 project-name          ← プロジェクトディレクトリ名が Vault 名
   📄 .env
      Email: admin@example.com
      Password: ••••••••
   📄 seeds/users.json
      Email: user1@test.com
      Password: ••••••••
      API_KEY: sk-xxxxx...
```

**設計方針:**
- 1プロジェクト = 1 Vault
- Vault 内に認証情報が見つかった全ファイルを表示
- パスワード/トークン/シークレットが存在するファイルのみ対象

---

## 3. 対応ファイル形式

| 形式 | 拡張子 | パース方式 |
|------|--------|-----------|
| 環境変数 | `.env`, `.env.*` | key=value 形式 |
| JSON | `.json` | JSON.parse（JSONC対応） |
| YAML | `.yaml`, `.yml` | js-yaml ライブラリ |
| CSV | `.csv` | ヘッダー行 + データ行 |
| JavaScript/TypeScript | `.js`, `.ts`, `.mjs`, `.cjs` | 正規表現抽出 |
| Python | `.py` | 正規表現抽出 |

### 3.1 除外パターン（デフォルト）

```
node_modules/
.git/
dist/
build/
__pycache__/
*.min.js
*.bundle.js
```

---

## 4. 検出対象フィールド

### 4.1 デフォルトフィールド（常に検索）

| カテゴリ | パターン |
|----------|----------|
| メール | `email`, `mail`, `e-mail` |
| パスワード | `password`, `passwd`, `pwd`, `pass` |
| ユーザー名 | `username`, `user`, `login`, `account` |
| トークン | `token`, `access_token`, `refresh_token`, `auth_token` |
| APIキー | `api_key`, `apikey`, `api-key`, `secret_key` |
| シークレット | `secret`, `credential`, `private_key` |

### 4.2 Vault 登録条件

以下のいずれかを含むファイルのみ Vault に追加:
- `password` フィールド
- `token` / `key` / `secret` を含むフィールド

---

## 5. UI 仕様（Desktop App）

### 5.1 メイン画面

```
┌─────────────────────────────────────┐
│  🔐 PassShare                       │
│  Version 1.0.0                      │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ ストア: 準備完了             │   │
│  │ GPG: 利用可能               │   │
│  │ Git: 接続済み               │   │
│  └─────────────────────────────┘   │
│                                     │
│  [Vault を開く] [プロジェクトをスキャン] │
└─────────────────────────────────────┘
```

### 5.2 Vault 一覧（プロジェクト単位）

```
┌─ 🔑 Vault 一覧 ──────────────── × ─┐
│ 📁 my-project           ▶         │
│ 📁 another-project      ▶         │
│ 📁 test-app             ▶         │
└─────────────────────────────────────┘
```

### 5.3 プロジェクト展開時

```
📁 my-project             ▼
   ┌────────────────────────────────┐
   │ 📄 .env                        │
   │   Email: admin@example.com  📋 │
   │   Password: ••••••••        📋 │
   ├────────────────────────────────┤
   │ 📄 seeds/users.json            │
   │   Email: user1@test.com     📋 │
   │   Password: ••••••••        📋 │
   │   API_KEY: sk-xxx...        📋 │
   └────────────────────────────────┘
```

**操作:**
- プロジェクト名クリック → 展開/折りたたみ
- 各フィールドクリック → クリップボードにコピー

### 5.4 スキャン結果画面

```
┌─ 📂 スキャン結果 ────────────── × ─┐
│ プロジェクト: my-project           │
│ スキャン済み: 42 ファイル           │
│ 検出: 5 件の資格情報               │
│ ✓ プロジェクトが登録されました      │
│                                     │
│ ┌─────────────────────────────────┐│
│ │ 📄 .env                         ││
│ │   admin@example.com             ││
│ │   ••••••••                      ││
│ └─────────────────────────────────┘│
│                                     │
│ [Vault を開く] [閉じる]             │
└─────────────────────────────────────┘
```

---

## 6. CLI 仕様

### 6.1 scan コマンド

```bash
passshare scan [directory] [options]
```

**オプション:**

| オプション | 説明 |
|-----------|------|
| `-n, --name <name>` | プロジェクト名を指定（デフォルト: ディレクトリ名） |
| `-f, --fields <fields>` | 追加検索フィールド（カンマ区切り） |
| `--dry-run` | 検出のみ（Vault 登録しない） |
| `--force` | 確認なしで登録 |

**実行例:**

```bash
# カレントディレクトリをスキャン
passshare scan

# 指定ディレクトリをスキャン
passshare scan ./my-project

# カスタムフィールドを追加
passshare scan -f "db_password,redis_url"

# ドライラン
passshare scan --dry-run
```

**出力例:**

```
📂 Scanning: /path/to/my-project
✓ Scanned 42 files
✓ Found 5 credentials in 3 files

Detected credentials:
  📄 .env
     - email: admin@example.com
     - password: ********
  📄 seeds/users.json
     - 2 user records with passwords
  📄 config.yaml
     - api_key: sk-***

? Register this project to vault? (Y/n) 
✓ Project registered: my-project
```

---

## 7. データフロー

```
[プロジェクトをスキャン]
        │
        ▼
┌─────────────────────┐
│ ディレクトリ選択     │
│ (dialog.showOpenDialog) │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ ファイルスキャン     │
│ - 除外パターン適用   │
│ - 拡張子フィルタ     │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ パース & 抽出        │
│ - 形式別パーサー     │
│ - フィールド検出     │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ 結果表示 & 登録      │
│ - スキャン結果表示   │
│ - プロジェクトパス保存 │
└─────────────────────┘


[Vault を開く]
        │
        ▼
┌─────────────────────┐
│ 登録プロジェクト読込  │
│ (passshare-projects.json) │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ 全プロジェクト再スキャン │
│ (最新状態を取得)     │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ Vault 一覧表示       │
│ (プロジェクト単位)   │
└─────────────────────┘
```

---

## 8. 設定ファイル

### 8.1 登録プロジェクト（永続化）

**パス:** `%APPDATA%/passshare-desktop/passshare-projects.json`（Windows）

```json
{
  "registeredProjects": [
    "C:/Users/dev/projects/my-project",
    "C:/Users/dev/projects/another-project"
  ]
}
```

**挙動:**
- 存在しないディレクトリは自動除外
- スキャン時に認証情報が見つかった場合のみ自動登録

---

## 受け入れ条件（Acceptance Criteria）

### AC-1: プロジェクトスキャン

```gherkin
Given ユーザーがデスクトップアプリを起動している
When 「プロジェクトをスキャン」ボタンをクリックし、ディレクトリを選択する
Then 選択したディレクトリ内の Seed ファイルがスキャンされ
And 検出された認証情報がスキャン結果画面に表示される
And パスワード/トークンを含むファイルが見つかった場合、プロジェクトが自動登録される
```
- [x] テストケース作成済み
- [x] 実装完了

### AC-2: Vault 表示（オンデマンド再スキャン）

```gherkin
Given 1つ以上のプロジェクトが登録されている
When ユーザーが「Vault を開く」をクリックする
Then 登録済みプロジェクトが全て再スキャンされ
And 最新の認証情報が Vault 一覧に表示される
```
- [x] テストケース作成済み
- [x] 実装完了

### AC-3: プロジェクト展開・コピー

```gherkin
Given Vault 一覧にプロジェクトが表示されている
When ユーザーがプロジェクト名をクリックする
Then プロジェクト内の全認証情報が展開表示される
And 各フィールドをクリックするとクリップボードにコピーされる
```
- [x] テストケース作成済み
- [x] 実装完了

### AC-4: 動的更新

```gherkin
Given プロジェクト A が登録済みである
And プロジェクト A の Seed ファイルが外部で変更された
When ユーザーが「Vault を開く」をクリックする
Then 変更後の最新認証情報が表示される
```
- [x] テストケース作成済み
- [x] 実装完了

---

## 異常系・境界値

| ケース | Given | When | Then |
|--------|-------|------|------|
| 空ディレクトリ | 認証情報のないディレクトリ | スキャン実行 | 「資格情報が検出されませんでした」表示、登録しない |
| 不正 JSON | 破損した JSON ファイル | スキャン実行 | エラーをスキップし、他ファイルを継続スキャン |
| 削除されたプロジェクト | 登録後にディレクトリ削除 | Vault を開く | 存在しないプロジェクトは自動除外 |
| 大量ファイル | node_modules 含む大規模プロジェクト | スキャン実行 | 除外パターンにより高速スキャン |
| 読み取り権限なし | 権限のないファイル | スキャン実行 | エラーをスキップし、他ファイルを継続 |

---

## 実装参照

### Desktop App

| ファイル | 役割 |
|----------|------|
| `desktop/src/main/ipc-handlers.ts` | IPC ハンドラ、スキャン/Vault ロジック |
| `desktop/src/preload/index.ts` | Renderer API 公開 |
| `desktop/src/renderer/index.html` | UI（スキャン/Vault 表示） |

### Core Library

| ファイル | 役割 |
|----------|------|
| `packages/passshare-ts/src/seed/scanner.ts` | ディレクトリスキャナー |
| `packages/passshare-ts/src/seed/extractor.ts` | 認証情報抽出 |
| `packages/passshare-ts/src/seed/parsers/*.ts` | 形式別パーサー |
| `packages/passshare-ts/src/seed/types.ts` | 型定義 |

### CLI

| ファイル | 役割 |
|----------|------|
| `packages/passshare-node/src/cli.ts` | `scan` コマンド実装 |

---

## テスト/検証参照

| 層 | 対象 | 実行コマンド | 状態 |
|----|------|-------------|------|
| unit | Parsers/Extractor | `pnpm -C packages/passshare-ts test` | ✅ |
| integration | IPC Handlers | - | ⬜ |
| e2e | Desktop App UI | 手動 | ✅ |

### 手動検証手順

1. `pnpm start` でデスクトップアプリを起動
2. 「プロジェクトをスキャン」→ テストプロジェクトを選択
3. スキャン結果に認証情報が表示されることを確認
4. 「Vault を開く」→ プロジェクトが一覧に表示
5. プロジェクトをクリック → 展開して全認証情報を確認
6. フィールドをクリック → クリップボードにコピーされることを確認
7. Seed ファイルを外部で編集 → 再度「Vault を開く」→ 更新が反映されることを確認
