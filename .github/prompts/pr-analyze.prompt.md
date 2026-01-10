## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
PRの差分を読み、**レビュー観点/リスク/追加で必要な情報**を整理する（分析）。

## 正本（必須）
- **開発サイクル入口（preflight/quality-gate/PR本文生成を含む）**: `.github/prompts/dev-cycle.prompt.md`
- **PR本文生成（専門Agent）**: `.github/agents/pr-writer.agent.md`
- **PR本文テンプレ**: `documents/templates/pr-template.md`

> NOTE: PR本文の「生成」自体は `dev-cycle` / `pr-writer` が正本です。
> このプロンプトは **分析**（レビューに必要な観点整理）に専念します。

## 入力
- 変更の背景/目的
- 変更内容（ファイル/機能単位）
- 影響範囲（Front/Back/Agent/Infra）
- 互換性/移行の有無
- 動作確認（コマンド/手動手順）

## 出力（日本語）
`documents/templates/pr-template.md` の項目を、そのまま埋めたMarkdownを返す。
不足情報があれば、最後に「確認したい質問」を列挙する。

