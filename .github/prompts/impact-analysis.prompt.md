## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
変更前に影響範囲を **テンプレ通りに**洗い出し、抜け漏れを防ぐ。

## テンプレ（正本 / MUST）
- `documents/templates/impact-analysis-template.md` を **完全に埋めたMarkdown** を出力する

## 記述方針（SSOT）
- `documents/spec/writing-guidelines.md`
影響範囲分析を `documents/templates/impact-analysis-template.md` に沿って作成する。

## 入力
- 変更概要（何を/なぜ）
- 対象モジュール（Front/Back/Agent/Infra）
- 破壊的変更の有無

## 出力（日本語）
`documents/templates/impact-analysis-template.md` の項目を埋めたMarkdown。
不明な項目は「要確認」とし、最後に質問を列挙する。


