## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
変更内容から、レビューしやすいコミットメッセージ案を作る（1コミット=1責務）。

## ルール
- 日本語OK（チーム運用に合わせる）
- 1行目は短く（50字目安）
- 本文に「理由/影響範囲/確認」を入れる
- フロント/バックの混在コミットは禁止（ブランチも分ける）

## 出力
- コミットメッセージ案（1〜3案）
- 各案の意図（なぜその表現にしたか）

