## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- フロント（React + TypeScript）を扱う場合は `.github/prompts/react-vite-ts-mindset.md` をSSOTとして遵守する
- バックエンド（FastAPI + MySQL + DDD）を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する

## 目的
このモノレポをローカルで動かすために、初心者でも迷わず環境構築できる状態を作る。

## 1コマンド入口（正本）
- `pnpm preflight`（クロスプラットフォーム共通）
- 統合テスト付き: `pnpm preflight:integration`

## 期待すること
- 必要コマンドの検出（git/python/pnpm/uv/docker）
- 必要なら submodule 初期化
- 品質ゲート（format/lint/typecheck/build/ruff/pytest）

## 注意
- `.github/workflows` は編集禁止。品質はローカルスクリプトで担保する。
- `.env` はコミットしない。テンプレは `env.example`（ルート）と `env.electron.example`（→ `electron/.env.local`）を参照。

## 完了時の出力（必須）
環境構築が完了したら、以下を **必ず** ユーザーに案内すること：

### 1. 環境構築の結果サマリ
- 成功した項目 / 失敗した項目を箇条書きで報告

### 2. 次のステップ案内（コピペ可能な形式で）
```
✅ 環境構築が完了しました。

【次のステップ】
実装を始める場合は、Cursorのチャット欄で以下のように依頼してください：

1. @.github/prompts/dev.prompt.md をメンション
2. 「○○を実装してください」と依頼

例：
@.github/prompts/dev.prompt.md ログイン画面のバリデーションを実装してください
```

