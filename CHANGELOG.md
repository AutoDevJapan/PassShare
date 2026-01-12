# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-11

### Added

- **Python Implementation** (`packages/passshare-python`)
  - Core functionality: Secret, Config, Store, Gopass classes
  - Crypto backends: GPG, Age, Plain (testing only)
  - Storage backends: GitFS, FS
  - Full CLI with all gopass-compatible commands
  - OTP/TOTP support
  - Clipboard integration with auto-clear
  - Password generation (random and XKCD-style)

- **TypeScript Implementation** (`packages/passshare-ts`)
  - Core functionality matching Python implementation
  - Full type safety with TypeScript
  - ESM and CommonJS dual build
  - Same API surface as Python version

- **Node.js CLI** (`packages/passshare-node`)
  - CLI wrapper using commander.js
  - Colored output with chalk
  - Tree-style listing
  - All gopass-compatible commands

- **Distribution Website**
  - React + Vite frontend (`frontend/`)
    - Landing page with features
    - Download page with installation instructions
    - Documentation browser
    - Responsive design with Tailwind CSS
  - FastAPI backend (`backend/`)
    - Release information API
    - Download statistics API
    - Documentation search API

- **Documentation**
  - API reference for Python and TypeScript
  - CLI command reference
  - Getting started guide
  - Security best practices

### Technical Details

- gopass config format compatibility
- GPG 2.x and Age encryption support
- Git-based synchronization
- Multiple recipients for team sharing
- Cross-platform support (Linux, macOS, Windows)

## [1.1.0] - 2026-01-12

### Added

- **Browser Extension Auto Setup**
  - デスクトップアプリ初回起動時に Native Messaging Host を自動設定
  - Chrome, Edge, Firefox 全ブラウザ対応
  - Windows, macOS, Linux 全プラットフォーム対応

- **Native Messaging Host**
  - ブラウザ拡張機能とデスクトップアプリ間の通信を実現
  - stdin/stdout による Chrome Native Messaging Protocol 実装
  - シークレットの取得、一覧表示、URL マッチングをサポート

- **ブラウザ拡張機能の改善**
  - Firefox 対応（browser_specific_settings 追加）
  - ビルド時のアイコン自動生成
  - popup.html パス修正

- **IPC ハンドラ**
  - `nativeHost:status` - インストール状態確認
  - `nativeHost:install` - 手動インストール
  - `nativeHost:uninstall` - アンインストール
  - `nativeHost:openExtensionStore` - ブラウザストアを開く

### Changed

- electron-builder 設定を更新（Native Host バンドル対応）

## [Unreleased]

### Planned

- Mobile app (React Native)
- Web vault interface
- HIBP integration for password auditing
- SSO integration

---

© 2026 株式会社BM1314. All rights reserved.
