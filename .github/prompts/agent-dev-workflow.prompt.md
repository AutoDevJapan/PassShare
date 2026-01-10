## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的（ターミナル不要運用）
開発者がターミナルを一切触らず、自然言語でAgentに依頼するだけで「環境構築→実装→テスト→適切なコミット→push→PR作成」まで完了させる。

## 絶対ルール（重要）
- **画面実装を含む場合**は、**フロント用ブランチ**と**バック用ブランチ**を必ず分ける
  - `feat/<slug>-frontend` / `feat/<slug>-backend`
- **1コミット=1責務**（Front/Back混在コミットは禁止）
- 人間は **GitHub PRの差分のみ**レビューする

## 正本
- Spec: `documents/spec/features/agent-driven-development.md`
- Git自動化: `scripts/git/agent_git.py`
- 入口統一（開発サイクル）: `.github/prompts/dev-cycle.prompt.md`

## 進め方（重要）
- **開発者（人間）の入口は `dev-cycle` を正本**とする（@参照＋目的＋完了条件）
- 本プロンプトの手順やコマンドは **Agent内部の実行手段**（参考）であり、人間が覚える/実行する必要はない


