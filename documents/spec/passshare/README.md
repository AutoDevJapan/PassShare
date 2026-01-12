# PassShare - チーム向けパスワードマネージャー（SSOT）

## 概要

**PassShare**は、チームと個人のためのセキュアなパスワードマネージャーです。GPG/Age暗号化とGitベースの同期により、複数デバイス・複数チームメンバー間で安全にパスワードを共有できます。

Python、TypeScript、Node.jsの3つの実装を提供し、CLI・API両方から利用可能です。

### 製品ポジショニング

- **独立した製品**: 自社開発のパスワード管理ソリューション
- **pass/gopass形式互換**: 既存のpass/gopassストアをそのまま利用可能
- **マルチプラットフォーム**: Linux, macOS, Windows対応
- **マルチ言語実装**: Python, TypeScript, Node.js

### ターゲットユーザー

1. **開発チーム**: API鍵、デプロイ認証情報の安全な共有
2. **DevOps/SRE**: CI/CDパイプラインでのシークレット管理
3. **個人開発者**: ローカル/クラウド間でのパスワード同期
4. **セキュリティ意識の高い組織**: GPG暗号化による堅牢なセキュリティ

### 競合との差別化

| 特徴 | PassShare | 1Password | Bitwarden | pass/gopass |
|------|-----------|-----------|-----------|-------------|
| オープンソース | ✅ | ❌ | ✅ | ✅ |
| セルフホスト | ✅ | ❌ | ✅ | ✅ |
| GPG暗号化 | ✅ | ❌ | ❌ | ✅ |
| Git同期 | ✅ | ❌ | ❌ | ✅ |
| プログラマティックAPI | ✅ | 制限あり | 制限あり | 制限あり |
| 複数言語SDK | ✅ (Py/TS/Node) | ❌ | ❌ | ❌ |

### ライセンス

MIT License（自社製品としてリリース）

### 商標・ブランディング

- **製品名**: PassShare
- **ロゴ**: `/logo.png`
- **著作権**: © 2026 株式会社BM1314. All rights reserved.
- **会社名**: 株式会社BM1314

### ブランドカラー

| 用途 | カラー | HEX |
|------|--------|-----|
| Primary (Purple) | 紫 | `#7B5CFA` |
| Secondary (Cyan) | シアン | `#00D9FF` |
| Background (Dark) | ダークグレー | `#2D2D2D` |
| Text (Light) | 白 | `#FFFFFF` |

## 参照ドキュメント

- [機能仕様](./features.md) - 全機能の詳細仕様
- [CLI仕様](./cli.md) - コマンドラインインターフェース仕様
- [ストレージ仕様](./storage.md) - ストレージバックエンド仕様
- [暗号化仕様](./crypto.md) - 暗号化バックエンド仕様
- [設定仕様](./config.md) - 設定ファイル仕様
- [API仕様](./api.md) - プログラマティックAPI仕様
- [Seed自動検出仕様](./seed-detection.md) - 開発プロジェクトのSeedデータ自動検出機能

## 製品ラインナップ

| パッケージ | ディレクトリ | 言語 | 配布形式 |
|-----------|-------------|------|---------|
| passshare (Python) | `packages/passshare-python/` | Python 3.11+ | PyPI |
| @passshare/core (TS) | `packages/passshare-ts/` | TypeScript 5.x | npm |
| passshare (Node) | `packages/passshare-node/` | Node.js 20+ | npm |

## コア機能

### 1. ストア管理
- `init` - 新規ストアの初期化
- `setup` - インタラクティブセットアップ
- `clone` - リモートストアのクローン
- `mounts` - マウントポイント管理（サブストア）

### 2. シークレット操作
- `show` - シークレットの表示
- `insert` - シークレットの追加
- `edit` - シークレットの編集
- `delete/rm` - シークレットの削除
- `generate` - パスワード生成
- `create` - インタラクティブ作成

### 3. ストア操作
- `list/ls` - シークレット一覧
- `find` - シークレット検索
- `grep` - シークレット内容検索
- `copy/cp` - シークレットのコピー
- `move/mv` - シークレットの移動

### 4. 同期
- `sync` - リモートとの同期
- `git` - Git操作（内部）

### 5. 受信者管理
- `recipients` - GPG受信者の管理
- `recipients add/remove/show`

### 6. 設定
- `config` - 設定の表示/変更
- 設定ファイル: `~/.config/gopass/config` (YAML)

### 7. その他
- `audit` - パスワード強度監査
- `otp` - TOTP/HOTP対応
- `env` - 環境変数としてエクスポート
- `templates` - テンプレート管理
- `convert` - バックエンド変換
- `fsck` - ストア整合性チェック

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│                    CLI Layer                        │
│  (コマンド解析、ユーザーインタラクション)              │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                   Action Layer                      │
│  (各コマンドのビジネスロジック)                       │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                 Store Layer (Root)                  │
│  (マウントポイント管理、パス解決)                     │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                 Store Layer (Leaf)                  │
│  (個別ストア操作)                                    │
└─────────────────────────────────────────────────────┘
                    │           │
                    ▼           ▼
┌─────────────────────────┐ ┌──────────────────────────┐
│    Crypto Backend       │ │    Storage Backend       │
│  (GPG, Age)             │ │  (Git+FS, FS, Fossil)   │
└─────────────────────────┘ └──────────────────────────┘
```

## ストレージ形式（pass/gopass形式互換）

```
~/.local/share/gopass/stores/root/
├── .gpg-id                 # GPG鍵ID一覧
├── .gopass-recipients      # 受信者情報（オプション）
├── .gitattributes          # Git属性
├── secret1.gpg             # 暗号化されたシークレット
├── folder/
│   ├── secret2.gpg
│   └── secret3.gpg
└── .git/                   # Gitリポジトリ
```

## シークレット形式

```
password-on-first-line
---
key1: value1
key2: value2
otpauth://totp/...
---
Freeform notes here
```

## 設定ファイル形式（~/.config/gopass/config）

```yaml
autoclip: true
clipctrl: "xclip"
clipmax: 45
concurrency: 10
export-keys: true
nopager: false
nocolor: false
path: ~/.local/share/gopass/stores/root
mounts:
  work: ~/.local/share/gopass/stores/work
  personal: ~/.local/share/gopass/stores/personal
```

## 暗号化バックエンド

### GPG（デフォルト）
- GnuPG 2.x互換
- 複数受信者対応
- `.gpg`拡張子

### Age（オプション）
- age encryption対応
- `.age`拡張子

## ストレージバックエンド

### gitfs（デフォルト）
- Git + ファイルシステム
- 自動コミット
- リモート同期

### fs
- プレーンファイルシステム
- バージョン管理なし

### fossil（オプション）
- Fossil SCM

## 品質基準・完了条件

各実装は以下を満たすこと:

### 機能要件
1. **全コマンド実装**: CLI仕様に定義された全コマンドが動作
2. **ストア互換性**: pass/gopass形式のストアを読み書き可能
3. **暗号化互換性**: GPG/Ageで暗号化されたファイルを復号可能
4. **設定互換性**: 既存のgopass設定ファイルを読み込み可能

### 非機能要件
1. **テストカバレッジ**: 80%以上
2. **ドキュメント**: README, APIリファレンス, 使用例
3. **型安全**: Python (mypy), TypeScript (strict mode)
4. **セキュリティ**: 秘密情報のメモリ管理、一時ファイル処理

### リリース基準
1. **pass/gopass統合テスト**: 既存ストアとの相互運用性確認
2. **クロスプラットフォームテスト**: Linux, macOS, Windows
3. **パフォーマンス**: 1000件のシークレット一覧表示が1秒以内

## 開発ロードマップ

### v0.1.0 - MVP（Minimum Viable Product）
- [ ] ストア初期化（init）
- [ ] シークレット操作（show/insert/delete）
- [ ] GPG暗号化/復号
- [ ] 基本的なリスト表示
- [ ] 設定ファイル読み込み

### v0.2.0 - チーム機能
- [ ] パスワード生成（generate/pwgen）
- [ ] Git同期（sync/git）
- [ ] マウントポイント（mounts）
- [ ] 受信者管理（recipients）

### v0.3.0 - 拡張機能
- [ ] OTPサポート（TOTP/HOTP）
- [ ] 監査機能（audit + HIBP）
- [ ] テンプレート
- [ ] Age暗号化バックエンド

### v1.0.0 - 製品版リリース
- [ ] 全プラットフォームテスト
- [ ] パフォーマンス最適化
- [ ] ドキュメント完備
- [ ] PyPI / npm パッケージ公開
- [ ] ブラウザ拡張連携（将来）

### 将来の拡張（v1.x+）
- [ ] Web UI（オプション）
- [ ] モバイルアプリ連携
- [ ] エンタープライズ機能（監査ログ、LDAP連携）
- [ ] Vault/AWS Secrets Manager連携
