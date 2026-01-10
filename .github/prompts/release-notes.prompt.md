## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
リリースノートを **テンプレ通りに**作成し、変更点と移行を一意に伝える。

## テンプレ（正本 / MUST）
- `documents/templates/release-notes-template.md` を **完全に埋めたMarkdown** を出力する

## 記述方針（SSOT）
- `documents/spec/writing-guidelines.md`
リリースノートを `documents/templates/release-notes-template.md` に沿って作成する。

## 入力
- 変更点（追加/変更/修正）
- 互換性/移行の有無
- 既知の問題

## 出力（日本語）
`documents/templates/release-notes-template.md` の項目を埋めたMarkdown。


