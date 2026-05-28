# リリースとセマンティックバージョニング

> Issue [#110](https://github.com/AutoDevJapan/PassShare/issues/110)  
> SSOT: [CHANGELOG.md](../../CHANGELOG.md)

## バージョン体系

PassShare は [Semantic Versioning 2.0.0](https://semver.org/) に従う。

| 桁 | 変更例 |
|----|--------|
| **MAJOR** | 破壊的 API 変更、暗号フォーマット変更、Connect 互換性破壊 |
| **MINOR** | 後方互換機能追加（新クライアント機能、新 Connect エンドポイント） |
| **PATCH** | バグ修正、セキュリティパッチ、依存関係更新 |

## パッケージ別バージョン

| パッケージ | ソース | 備考 |
|-----------|--------|------|
| Rust workspace | `Cargo.toml` `[workspace.package] version` | core / connect / op-cli / desktop / mobile |
| Backend | `backend/package.json` `version` | API デプロイ識別 |
| Web / Desktop / Mobile / Extension | 各 `package.json` | UI リリース |
| Git tag | `v{MAJOR}.{MINOR}.{PATCH}` | リリース SSOT |

**原則**: ユーザー向けリリース（v2.0.0 等）は Git tag が SSOT。各 package.json は tag と同期する。

## CHANGELOG 運用

1. マージ可能な PR では `[Unreleased]` セクションに変更を追記
2. リリース時に `[Unreleased]` を `[X.Y.Z] - YYYY-MM-DD` にリネーム
3. カテゴリ: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
4. ユーザー向け用語は **パスワードボックス** を使用

## Tag 作成手順

```powershell
# 1. CHANGELOG 確定 + version bump コミット
# 2. main 上で tag
git tag -a v2.0.0 -m "PassShare v2.0.0"
git push origin v2.0.0
```

## Desktop updater

- `apps/desktop/src-tauri/tauri.conf.json` の `version` を tag と一致させる
- GitHub Releases + `latest.json` — [desktop-release.md](../runbooks/desktop-release.md)

## 関連

- [production-release.md](../runbooks/production-release.md)
- [CHANGELOG.md](../../CHANGELOG.md)
