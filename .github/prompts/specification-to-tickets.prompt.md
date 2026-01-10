## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
Spec（`documents/spec/`）から、実装可能なタスク一覧へ落とし込む。

## 入力
- 対象Spec（API/UI/DB/Feature/Usecase/Error Codes）

## 出力（日本語）
- タスク一覧（順序付き）
  - 影響層（Backend: Domain/Usecase/Infrastructure/Presentation、Front: UI/hooks/services、Agent/Infra）
  - 追加/変更ファイルの目安
  - テスト観点（unit/integration/e2e）
  - リスク（互換性/移行/セキュリティ/性能）

