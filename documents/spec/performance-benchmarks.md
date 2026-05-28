# パフォーマンスベンチマーク

> Issue [#109](https://github.com/AutoDevJapan/PassShare/issues/109)  
> 親 Epic: [#36](https://github.com/AutoDevJapan/PassShare/issues/36)

## 目的

KDF レイテンシ、Connect API 応答時間、Web LCP の基準値を定義し、CI で回帰を検知する。

## 自動ベンチマーク（CI）

Workflow: `.github/workflows/quality-gate.yml` → job `benchmark`  
Script: `scripts/bench/run.mjs`  
Artifact: `bench-results.json`

| メトリクス | 測定方法 | 上限（CI） |
|-----------|---------|-----------|
| **KDF (Argon2id)** | `cargo test kdf_reference_timing` | 5000 ms |
| **API /health p95** | 100 リクエスト in-memory backend | 50 ms |

### ローカル実行

```powershell
node scripts/bench/run.mjs
# → bench-results.json
```

## 手動ベンチマーク

### Web LCP（Lighthouse）

| ページ | 目標 | Issue |
|--------|------|-------|
| ランディング `/` | LCP < 2.5s, A11y 90+ | [#69](https://github.com/AutoDevJapan/PassShare/issues/69) |
| アプリ `/app` | LCP < 2.5s, A11y 90+ | [#69](https://github.com/AutoDevJapan/PassShare/issues/69) |

```powershell
cd frontend
pnpm run build
pnpm exec lighthouse http://localhost:4173 --only-categories=performance,accessibility
```

## ベースライン記録

| 日付 | KDF ms | API p95 ms | 環境 | 備考 |
|------|--------|------------|------|------|
| 2026-05-28 | — | — | CI ubuntu-latest | 初回 Epic #36 導入 |

## 回帰対応

1. CI `benchmark` job 失敗 → 閾値超過を確認
2. 意図的な変更（KDF パラメータ等）の場合は閾値と本ドキュメントを更新
3. 非意図的な回帰は PR をブロックして修正

## 関連

- [crypto.rs](../../crates/passshare-core/src/crypto.rs) — `KDF_MEMORY_KIB`, `KDF_TIME_COST`
- [quality-gate.yml](../../.github/workflows/quality-gate.yml)
