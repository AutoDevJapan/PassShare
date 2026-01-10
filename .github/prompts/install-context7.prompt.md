## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
公式パターン参照向けツール（Context7等）を導入したい場合に、環境に合わせた手順を整理する。

## 入力（質問して埋める）
- OS（Windows/macOS/Linux）
- ネットワーク制約（社内/プロキシ）
- CursorのMCP設定方針

## 出力
- インストール手順
- 有効化/疎通確認
- 運用ルール（どの場面で使うか、使わないか）

