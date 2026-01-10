## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
ADRを **テンプレ通りに**作成し、設計判断を「後から読んで同じ結論に到達できる」形で残す。

## テンプレ（正本 / MUST）
- `documents/templates/adr-template.md` を **完全に埋めたMarkdown** を出力する

## 記述方針（SSOT）
- `documents/spec/writing-guidelines.md`
設計判断（ADR）を `documents/templates/adr-template.md` に沿って作成する。

## 入力
- 何を決めるか（Decision）
- 背景（Context）
- 代替案（Options）

## 出力（日本語）
`documents/templates/adr-template.md` の項目を埋めたMarkdown。
トレードオフとロールバックを必ず書く。


