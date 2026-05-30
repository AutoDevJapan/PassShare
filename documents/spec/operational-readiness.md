# Operational Readiness（Web / CLI / Desktop）

> Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205)  
> 最終更新: 2026-05-29

## 目的

PassShare を **Web ポータル**・**op 互換 CLI**・**Tauri デスクトップ** の 3 クライアントとして、ローカル開発・CI・ステージングで **再現可能に動作すること** を担保する。

## 子 Issue と受入基準の対応

| Issue | 領域 | 成果物 | 自動化 |
|-------|------|--------|--------|
| [#206](https://github.com/AutoDevJapan/PassShare/issues/206) | Web ローカル | [local-dev-web.md](../runbooks/local-dev-web.md) | Playwright `auth-crud`（Quality Gate） |
| [#207](https://github.com/AutoDevJapan/PassShare/issues/207) | Web デプロイ smoke | `scripts/stg-web-smoke.mjs` | `stg-smoke.yml` workflow_dispatch |
| [#208](https://github.com/AutoDevJapan/PassShare/issues/208) | Infra preview | `deploy-preview.yml` / [infrastructure.md](./infrastructure.md) | PR `deploy-backend-preview` |
| [#209](https://github.com/AutoDevJapan/PassShare/issues/209) | CLI E2E | `backend/test/op-cli-e2e.test.js` | Quality Gate `docker-e2e` |
| [#210](https://github.com/AutoDevJapan/PassShare/issues/210) | CLI リリース | [op-cli.md](../runbooks/op-cli.md) | `op-cli-build.yml` artifact |
| [#211](https://github.com/AutoDevJapan/PassShare/issues/211) | Desktop クラウド同期 | `backend/test/cloud-sync.integration.test.js` | Quality Gate `docker-e2e` |
| [#212](https://github.com/AutoDevJapan/PassShare/issues/212) | Desktop MVP smoke | `passshare-desktop` `smoke_*` | Quality Gate `desktop-smoke` |
| [#213](https://github.com/AutoDevJapan/PassShare/issues/213) | Desktop ローカル | [local-dev-desktop.md](../runbooks/local-dev-desktop.md) | 手動（Runbook） |
| [#214](https://github.com/AutoDevJapan/PassShare/issues/214) | Cross-client | `scripts/cross-client-smoke.mjs` | Quality Gate `docker-e2e` |

## Epic 完了条件

- [ ] 上記子 Issue すべて Close
- [ ] [staging-acceptance.md](../runbooks/staging-acceptance.md) に Web / CLI / Desktop の自動 smoke 手順が追記済み
- [ ] Quality Gate に CLI 統合 E2E + Desktop クラウド同期 + Cross-client smoke が含まれる

## 関連 SSOT

- [feature-passshare-mvp.md](./feature-passshare-mvp.md)
- [production-v2.md](./production-v2.md)
- [infrastructure.md](./infrastructure.md)
- [desktop-cloud-sync.md](./desktop-cloud-sync.md)
- [staging-acceptance.md](../runbooks/staging-acceptance.md)
