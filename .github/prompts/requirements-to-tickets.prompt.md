## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
要求を、実装タスク（チケット）に分解する。

## 出力（日本語）
- チケット一覧（1行=1チケット）
  - タイトル
  - 目的（Done条件）
  - 影響範囲（Front/Back/Agent/Infra）
  - 依存（先に必要なSpec/他タスク）
  - 確認方法（最小）

## ルール
- Specが未作成/未確定なら「Spec作成」チケットを最優先に入れる
- 破壊的変更がある場合は「移行/ロールバック」チケットを必ず入れる

