## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- フロント（React + TypeScript）を扱う場合は `.github/prompts/react-vite-ts-mindset.md` をSSOTとして遵守する
- バックエンド（FastAPI + MySQL + DDD）を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する

## 目的
変更内容から、必要なドキュメント更新（Spec/README/設定説明/技術スタック）を漏れなく洗い出し、差分案を作る。

## 入力
- 変更内容（対象ファイル/挙動差分）
- 変更理由（目的/完了条件）

## 出力（日本語）
1. 更新すべきドキュメント一覧（ファイルパス）
2. 各ドキュメントの追記/修正ポイント（箇条書き）
3. 参照切れチェック項目（リンク/パス）

## SSOT（このリポジトリ）
- Spec: `documents/spec/`
- テンプレ: `documents/templates/`
- 設定説明: `documents/config/README.md`
- 技術スタック: `documents/tech-stack.md`


