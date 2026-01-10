## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- Electron + Vite + React + TypeScript を扱う場合は `.github/prompts/electron-vite-react-ts-mindset.md` をSSOTとして遵守する
- FastAPI + MySQL + DDD を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する
- Python / JSON-RPC over stdio で RPAエージェントを扱う場合は `.github/prompts/python-jsonrpc-stdio-agent-mindset.md` をSSOTとして遵守する
 - Terraform（ai-infra）を扱う場合は `.github/prompts/terraform-infra-mindset.md` をSSOTとして遵守する

## 目的
変更を提出する前の「最低限の品質ゲート」をチェックし、足りない観点を洗い出す。

## 出力（日本語 / 箇条書き）
- **Spec整合**: `documents/spec/` に差分が必要か（不足があれば追記案）
- **影響範囲**: `documents/templates/impact-analysis-template.md` が埋まっているか
- **テスト計画**: `documents/templates/test-plan-template.md` が埋まっているか
- **互換性/移行**: 破壊的変更がある場合、移行/ロールバックが書かれているか
- **テスト（最優先）**: 整備されている範囲で **APIテスト/E2Eテストが通るまで**改善を続ける（実行できない場合は理由と代替検証と残リスクを明記）
- **フロント（変更ありの場合）**: `pnpm -C electron build` を実行する
- **バック（変更ありの場合）**: `backend/README.md` の最小確認（起動/主要API）
- **エージェント（変更ありの場合）**: `runner/README.md` の疎通確認
- **セキュリティ**: 秘密情報がログ/例外/UIに出ない

