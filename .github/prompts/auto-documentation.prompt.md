## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- フロント（React + TypeScript）を扱う場合は `.github/prompts/react-vite-ts-mindset.md` をSSOTとして遵守する
- バックエンド（FastAPI + MySQL + DDD）を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する

---

## PassShare 機能一覧（SSOT / 1Password互換）

**目的**: PassShareが1Password同等のパスワードマネージャーとして機能するために必要な全機能を一元管理する。

### 凡例
| 記号 | 意味 |
|------|------|
| ✅ | 実装済み |
| 🔲 | 未実装 |
| 🚧 | 実装中 |
| ⏳ | 計画中 |
| ➖ | 対象外（意図的に実装しない） |

---

### 1. パスワード管理（コア機能）

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| パスワード保存 | Webサイト/アプリのログイン情報を保存 | 🔲 | `packages/passshare-*/` | `insert` コマンド |
| パスワード自動入力 | ブラウザでの自動入力 | 🔲 | `browser-extension/` | Phase 3 |
| パスワード生成 | ランダム/記憶しやすいパスワード生成 | 🔲 | `packages/passshare-*/` | `generate` コマンド |
| パスワード表示/コピー | 復号して表示/クリップボードへコピー | 🔲 | `packages/passshare-*/` | `show` コマンド |
| パスワード編集 | 既存パスワードの変更 | 🔲 | `packages/passshare-*/` | `edit` コマンド |
| パスワード削除 | シークレットの削除 | 🔲 | `packages/passshare-*/` | `rm` コマンド |
| パスワード検索 | 名前/内容で検索 | 🔲 | `packages/passshare-*/` | `find`/`grep` コマンド |

---

### 2. 二要素認証（2FA）

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| TOTP管理 | 認証アプリ形式のコード管理 | 🔲 | `packages/passshare-*/` | `otp` コマンド |
| TOTP自動入力 | ブラウザでの2FAコード自動入力 | 🔲 | `browser-extension/` | Phase 3 |
| QRコードスキャン | カメラでQRコード読み取り | 🔲 | `mobile/` | Phase 4 |
| HOTP対応 | カウンターベースOTP | 🔲 | `packages/passshare-*/` | 低優先度 |

---

### 3. パスキー（Passkeys）

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| パスキー保存 | WebAuthnパスキーの保存 | 🔲 | `packages/passshare-*/` | Phase 3以降 |
| パスキー認証 | パスキーを使用したログイン | 🔲 | `browser-extension/` | Phase 3以降 |
| デバイス間同期 | パスキーの同期 | 🔲 | 全プラットフォーム | Phase 4以降 |

---

### 4. 機密情報の保管

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| クレジットカード | カード番号/有効期限/CVV | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| 銀行口座 | 口座番号/支店コード | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| 住所・個人情報 | 氏名/住所/電話番号 | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| セキュアノート | 自由形式のメモ | 🔲 | `packages/passshare-*/` | マルチライン対応済み |
| 身分証明書 | パスポート/免許証/マイナンバー | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| ソフトウェアライセンス | プロダクトキー/シリアル番号 | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| ドキュメント添付 | ファイルの暗号化保存 | 🔲 | `packages/passshare-*/` | Phase 2以降 |

---

### 5. セキュリティ機能

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| Watchtower相当 | 脆弱パスワード検出 | 🔲 | `packages/passshare-*/` | `audit` コマンド |
| データ侵害アラート | Have I Been Pwned連携 | 🔲 | `packages/passshare-*/` | `audit` コマンド |
| 重複パスワード検出 | 同一パスワードの検出 | 🔲 | `packages/passshare-*/` | `audit` コマンド |
| 再利用パスワード警告 | パスワード再利用の警告 | 🔲 | `desktop/` / `browser-extension/` | Phase 2以降 |
| AES-256暗号化 | データの暗号化 | ✅ | `packages/passshare-*/` | GPG/Age対応 |
| ゼロ知識証明 | サーバーはデータを復号不可 | ✅ | 設計 | E2E暗号化 |
| 自動ロック | アイドル時の自動ロック | 🔲 | `desktop/` / `mobile/` | Phase 2/4 |
| 生体認証 | Face ID / Touch ID / 指紋認証 | 🔲 | `mobile/` | Phase 4 |
| マスターパスワード | GPG鍵パスフレーズ | ✅ | `packages/passshare-*/` | GPG統合 |

---

### 6. 共有・コラボレーション

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| 家族/チーム共有 | Vault単位での共有 | 🔲 | `packages/passshare-*/` | `recipients` 機能 |
| 権限管理 | 閲覧のみ/編集可の制御 | 🔲 | 設計 | GPG受信者ベース |
| 一時的な共有 | 期限付きリンク共有 | 🔲 | `backend/` | API実装済み |
| ゲストアクセス | 非会員への一時共有 | 🔲 | `backend/` | Phase 2以降 |
| 共有Vault | チーム用の共有ストア | 🔲 | `packages/passshare-*/` | マウントポイント |

---

### 7. マルチプラットフォーム

| プラットフォーム | 説明 | PassShare対応 | 実装場所 | 備考 |
|------------------|------|---------------|----------|------|
| Windows | デスクトップアプリ | 🔲 | `desktop/` | Phase 2（Electron） |
| macOS | デスクトップアプリ | 🔲 | `desktop/` | Phase 2（Electron） |
| Linux | デスクトップアプリ | 🔲 | `desktop/` | Phase 2（Electron） |
| iOS | モバイルアプリ | 🔲 | `mobile/` | Phase 4（React Native） |
| Android | モバイルアプリ | 🔲 | `mobile/` | Phase 4（React Native） |
| Chrome拡張 | ブラウザ拡張機能 | 🔲 | `browser-extension/` | Phase 3 |
| Firefox拡張 | ブラウザ拡張機能 | 🔲 | `browser-extension/` | Phase 3 |
| Safari拡張 | ブラウザ拡張機能 | 🔲 | `browser-extension/` | Phase 3 |
| Edge拡張 | ブラウザ拡張機能 | 🔲 | `browser-extension/` | Chrome互換 |
| CLI | コマンドラインツール | 🔲 | `packages/passshare-*/` | Phase 1（優先） |
| Web UI | ブラウザからアクセス | 🔲 | `frontend/` | Phase 5（オプション） |

---

### 8. 開発者向け機能

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| SSH鍵管理 | SSH秘密鍵の保管 | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| SSH Agent連携 | ssh-agent統合 | 🔲 | `packages/passshare-*/` | Phase 2以降 |
| APIトークン管理 | APIキーの保管 | 🔲 | `packages/passshare-*/` | テンプレート対応 |
| 環境変数注入 | シークレットを環境変数化 | 🔲 | `packages/passshare-*/` | `env` コマンド |
| CLI | コマンドラインインターフェース | 🔲 | `packages/passshare-*/` | Phase 1 |
| SDK（Python） | プログラマティックAPI | 🔲 | `packages/passshare-python/` | Phase 1 |
| SDK（TypeScript） | プログラマティックAPI | 🔲 | `packages/passshare-ts/` | Phase 1 |
| SDK（Node.js） | プログラマティックAPI | 🔲 | `packages/passshare-node/` | Phase 1 |
| Git署名 | GPG鍵でコミット署名 | 🔲 | `packages/passshare-*/` | Phase 2以降 |
| CI/CD連携 | GitHub Actions等との統合 | 🔲 | 設計 | Phase 2以降 |
| Seed自動検出 | プロジェクト内の認証情報検出 | 🔲 | `desktop/` | 独自機能 |

---

### 9. エンタープライズ機能

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| SSO統合 | SAML/OIDC対応 | 🔲 | `backend/` | Phase 5 |
| SCIM対応 | ユーザープロビジョニング | 🔲 | `backend/` | Phase 5 |
| 監査ログ | アクセス履歴の記録 | 🔲 | `backend/` | Phase 5 |
| ポリシー管理 | パスワードポリシーの強制 | 🔲 | `backend/` | Phase 5 |
| レポート | セキュリティレポート生成 | 🔲 | `backend/` | Phase 5 |
| Extended Access Management | デバイス/アプリ管理 | 🔲 | 設計 | Phase 5以降 |
| LDAP/AD連携 | Active Directory統合 | 🔲 | `backend/` | Phase 5以降 |

---

### 10. 同期・バックアップ

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| Git同期 | Gitリポジトリ経由の同期 | 🔲 | `packages/passshare-*/` | `sync` コマンド |
| ローカルストレージ | ファイルシステム保存 | 🔲 | `packages/passshare-*/` | fs バックエンド |
| クラウド同期 | PassShare Cloud（オプション） | 🔲 | `backend/` | Phase 5 |
| エクスポート | JSON/CSV形式でエクスポート | 🔲 | `packages/passshare-*/` | Phase 1 |
| インポート | 1Password/Bitwarden形式 | 🔲 | `packages/passshare-*/` | Phase 1 |
| バックアップ | 暗号化バックアップ | 🔲 | `packages/passshare-*/` | Phase 2 |
| 履歴・リビジョン | 変更履歴の参照 | 🔲 | `packages/passshare-*/` | `history` コマンド |

---

### 11. UX機能

| 機能 | 説明 | PassShare対応 | 実装場所 | 備考 |
|------|------|---------------|----------|------|
| クイックアクセス | ショートカットで即座にアクセス | 🔲 | `desktop/` | Phase 2 |
| お気に入り | よく使うアイテムをピン留め | 🔲 | `desktop/` / `mobile/` | Phase 2/4 |
| タグ/カテゴリ | アイテムの整理 | 🔲 | `packages/passshare-*/` | フォルダ構造で対応 |
| 最近使用したアイテム | 履歴表示 | 🔲 | `desktop/` / `mobile/` | Phase 2/4 |
| ダークモード | ダークテーマ対応 | 🔲 | `desktop/` / `mobile/` / `frontend/` | 全プラットフォーム |
| 多言語対応（i18n） | 日本語/英語等 | 🔲 | 全プラットフォーム | Phase 2以降 |
| クリップボード自動クリア | コピー後の自動消去 | 🔲 | `packages/passshare-*/` | 45秒後 |

---

## 実装フェーズ別サマリ

| フェーズ | 期間 | 主要機能 | 対応カテゴリ |
|---------|------|----------|--------------|
| Phase 1 | 2026 Q1 | CLI/SDK強化 | 1, 2, 4, 8, 10 |
| Phase 2 | 2026 Q2 | デスクトップアプリ | 5, 7, 11 |
| Phase 3 | 2026 Q3 | ブラウザ拡張機能 | 1, 2, 3, 7 |
| Phase 4 | 2026 Q4 | モバイルアプリ | 5, 7, 11 |
| Phase 5 | 2027+ | クラウド/エンタープライズ | 6, 9, 10 |

---

## 関連ドキュメント（SSOT参照先）

| 種別 | パス |
|------|------|
| 機能仕様（詳細） | `documents/spec/passshare/features.md` |
| CLI仕様 | `documents/spec/passshare/cli.md` |
| API仕様 | `documents/spec/passshare/api.md` |
| ロードマップ | `documents/spec/feature-roadmap.md` |
| トレーサビリティ台帳 | `documents/spec/index.md` |

---

## ドキュメント自動更新ガイド

### 目的
変更内容から、必要なドキュメント更新（Spec/README/設定説明/技術スタック）を漏れなく洗い出し、差分案を作る。

### 入力
- 変更内容（対象ファイル/挙動差分）
- 変更理由（目的/完了条件）

### 出力（日本語）
1. 更新すべきドキュメント一覧（ファイルパス）
2. 各ドキュメントの追記/修正ポイント（箇条書き）
3. 参照切れチェック項目（リンク/パス）
4. **本ファイルの機能一覧の対応状況更新**（🔲→🚧→✅）

### SSOT（このリポジトリ）
- 機能一覧: `.github/prompts/auto-documentation.prompt.md`（本ファイル）
- Spec: `documents/spec/`
- テンプレ: `documents/templates/`
- 設定説明: `documents/config/README.md`
- 技術スタック: `documents/tech-stack.md`

