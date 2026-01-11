# PassShare

<p align="center">
  <img src="logo.png" alt="PassShare Logo" width="120" height="120">
</p>

<p align="center">
  <strong>チームと個人のためのセキュアなパスワードマネージャー</strong>
</p>

<p align="center">
  <a href="https://passshare.dev">Website</a> •
  <a href="https://passshare.dev/docs">Documentation</a> •
  <a href="https://github.com/bm1314/passshare">GitHub</a>
</p>

---

**© 2026 株式会社BM1314. All rights reserved.**

## 概要

PassShareは、pass/gopassと完全互換のオープンソースパスワードマネージャーです。GPG/Age暗号化とGitベースの同期により、安全にパスワードを管理・共有できます。

### 特徴

- 🔐 **GPG/Age暗号化** - 業界標準の暗号化でパスワードを保護
- 🔄 **Git同期** - 自動バージョン管理と複数デバイス間での同期
- 👥 **チーム共有** - 複数の受信者に対応した安全な共有
- 🔧 **gopass互換** - 既存のpass/gopassストアをそのまま利用可能
- 💻 **CLI & API** - コマンドラインとプログラマティックAPI両対応
- 🌐 **マルチ言語SDK** - Python、TypeScript、Node.jsに対応

## クイックスタート

### インストール

```bash
# Python
pip install passshare

# Node.js CLI
npm install -g passshare

# TypeScript Library
npm install @passshare/core
```

### 基本的な使い方

```bash
# ストアを初期化
passshare init 0xYOURGPGKEY

# パスワードを追加
passshare insert email/gmail

# パスワードを表示
passshare show email/gmail

# パスワードを生成
passshare generate website/example 24

# 一覧表示
passshare list
```

### API使用例

**Python:**

```python
from passshare import Gopass, Secret

gopass = Gopass()
secret = gopass.get("email/gmail")
print(secret.password)
```

**TypeScript:**

```typescript
import { Gopass, Secret } from '@passshare/core';

const gopass = new Gopass();
const secret = await gopass.get('email/gmail');
console.log(secret.password);
```

## プロジェクト構成

```text
PassShare/
├── packages/
│   ├── passshare-python/    # Python実装（PyPI配布）
│   ├── passshare-ts/        # TypeScript実装（npm配布）
│   └── passshare-node/      # Node.js CLI（npm配布）
├── backend/                  # 配布サイトAPI（FastAPI）
├── frontend/                 # 配布サイトUI（React + Vite）
├── documents/               # 仕様書
└── docker-compose.yml
```

## 開発

### 前提条件

| 項目 | バージョン |
|------|----------|
| Python | 3.11+ |
| Node.js | 18+ |
| pnpm | 9+ |
| Docker | Latest |

### 環境構築

```bash
# 依存関係のインストール
pnpm install

# Python依存関係
cd packages/passshare-python && uv sync

# 開発サーバー起動
pnpm dev
```

### 品質ゲート

```bash
pnpm quality-gate
```

## ドキュメント

- [CLI リファレンス](documents/spec/passshare/cli.md)
- [API リファレンス](documents/spec/passshare/api.md)
- [ストレージ仕様](documents/spec/passshare/storage.md)
- [暗号化仕様](documents/spec/passshare/crypto.md)
- [設定仕様](documents/spec/passshare/config.md)

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。

## 会社情報

**株式会社BM1314**

- Website: https://bm1314.co.jp
- Email: info@bm1314.co.jp
