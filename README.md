# FastAPI x React Fullstack Template

開発者（人間）が **ターミナルを触らず**、Cursor上で **自然言語でAgentに依頼するだけ** で開発できるフルスタックテンプレートです。

## TL;DR（最短の入口）
- **環境構築**: `.github/prompts/setup.prompt.md` を使ってAgentに依頼（preflight実行）
- **実装を始める**: `.github/prompts/dev.prompt.md` の入力テンプレだけ埋めて依頼
- **品質担保**: `pnpm quality-gate`（Agentが実行）

---

## 🚀 初めての環境構築

### Step 1: Cursorでプロンプトファイルをメンション
Cursorのチャット欄で以下のようにメンション（`@` で補完）してください：

```
@.github/prompts/setup.prompt.md
```

### Step 2: 依頼文を入力して送信
```
このリポジトリをローカルで動かせるように環境構築してください。
```

### Step 3: Agentが自動で環境構築を実行
- 必要コマンドの検出（git/python/pnpm/uv/docker）
- 依存関係のインストール
- 品質ゲート（format/lint/typecheck/build）

---

## 前提条件

| 項目 | 必須 | 確認方法 |
|------|------|----------|
| **Docker Desktop** | ✅ | `docker --version` |
| **Node.js** (v20+) | ✅ | `node --version` |
| **pnpm** (v10+) | ✅ | `pnpm --version` |
| **Python** (3.11+) | ✅ | `python --version` |
| **uv** | ✅ | `uv --version` |

---

## プロジェクト構成

```text
/
├── backend/           # バックエンド（FastAPI + MySQL）
├── frontend/          # フロント（React + Vite）
├── scripts/           # 品質ゲート / preflight
├── documents/         # Spec/テンプレ/設定SSOT
└── docker-compose.yml # 開発用（MySQL + API）
```

---

## 開発の入口

### 環境構築
**正本プロンプト**: `.github/prompts/setup.prompt.md`

### 実装〜PRまで
**正本プロンプト**: `.github/prompts/dev.prompt.md`

---

## 品質ゲート（必須）
- `pnpm quality-gate`（または `pnpm qg`）

---

## よく使うURL（ローカル）
- フロント（Vite）: `http://localhost:5173`
- バックエンドAPI: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`
- health: `http://localhost:8000/health`

---

## ドキュメント
- `documents/README.md`
- `documents/spec/` - 仕様SSOT
- `AGENTS.md` - AI Agent向けガイド
