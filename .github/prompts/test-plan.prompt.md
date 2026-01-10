## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
テスト計画を **テンプレ通りに**作成し、実装と検証を同期させる。

## テンプレ（正本 / MUST）
- `documents/templates/test-plan-template.md` を **完全に埋めたMarkdown** を出力する

## 記述方針（SSOT）
- `documents/spec/writing-guidelines.md`

## 入力
- 変更内容（Spec/実装差分）
- 失敗しうるポイント（境界値/異常系）

## 出力（日本語）
`documents/templates/test-plan-template.md` の項目を埋めたMarkdown。
unit/integration/e2e のどれが必要か、根拠と一緒に示す。


