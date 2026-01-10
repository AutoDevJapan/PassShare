## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
要求を、実装できる粒度のSpec（SSOT）に変換する。

## 参照（テンプレ）
- `documents/spec/api-template.md`
- `documents/spec/ui-template.md`
- `documents/spec/db-template.md`
- `documents/spec/feature-template.md`
- `documents/spec/usecase-template.md`
- `documents/spec/error-codes-template.md`

## 出力（日本語）
1) まず「不足情報（質問）」を列挙（5〜10個まで、優先度順）
2) 次に、必要なSpecの種類（API/UI/DB/Feature/Usecase/Error Codes）を選び、テンプレに沿って叩き台を書く
3) 互換性/移行/ロールバックを必ず埋める（不明なら仮置き+要確認）

## 保存先（前提）
- Specは `documents/spec/` 配下に新規作成する想定で、ファイル名案も提示する

