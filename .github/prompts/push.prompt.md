## 運用規約（SSOT）
- .github/agents/user-clone.agent.md を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
push/提出前に「やるべきこと」を漏れなく整理する（**基本はAgentが実行**）。

## 出力（チェックリスト）
- ローカル確認（必要コマンド/結果）
- 仕様（`documents/spec`）反映の有無
- テンプレ（影響分析/テスト計画/PR本文）作成状況
- 破壊的変更/移行/ロールバックの明記
- 機密情報の混入チェック（ログ/設定/スクショ等）

## 補足（ターミナル不要運用）
- Agentは `scripts/git/agent_git.py` で commit/push/PR 作成まで行う
- 画面実装は `-frontend` / `-backend` ブランチ分離が必須

