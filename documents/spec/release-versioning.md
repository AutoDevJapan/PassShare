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

## M7-A: 未公開Desktop候補の検査

`desktop-signed-candidate.yml` は手動起動専用の準備工程であり、タグ・Release・更新用の公開manifestを作らない。現在のソース版を候補版とし、配布の準備のために版や更新用公開鍵を変更しない。

- 起動時の非公開リポジトリのmainに限定し、入力は40桁のSHAだけ。workflowのSHA・checkoutのSHAと一致しなければ失敗する。
- `package.json`、Tauri設定、Rust workspaceの版を読み取りだけで照合する。追加のOS別Tauri設定は、検査への明示対応まで拒否する。
- 更新署名の信頼基準は現行Tauri公開鍵。候補や生成manifestから読み込んだ別の公開鍵で成功を自己証明しない。
- OSの発行元署名と更新署名を別々に検査する。WindowsはAuthenticodeと時刻署名、macOSはDeveloper IDと公証、Linuxは更新パッケージのminisign署名を検査する。
- 検査成功後に限り、候補の本体・公開署名・証拠JSONを7日間の非公開CI成果物に保存する。証明書、秘密鍵、作業用設定、子プロセスのログは保存しない。

証拠JSONはソースSHA、3種類の版、公開鍵の指紋、実ファイルのサイズ・SHA256・署名の検査結果・アプリ本体のSHA256を記録する。ソースSHAは信頼した実行環境の由来であり、再現ビルドによる同一性の証明ではない。取得する担当はGitHub上の成功したworkflow/runとそのSHAを先に照合する。

署名環境・既存秘密鍵が不足する間は明示的に失敗する。通常の3OS無署名CIには署名秘密を要求しない。候補の署名成功だけでM7-A全体、M7、原22条件を完了としない。対応OSでの導入・起動・実更新・削除と、公開後の実URLから取得したバイトと署名の照合が必要である。

## 関連

- [production-release.md](../runbooks/production-release.md)
- [CHANGELOG.md](../../CHANGELOG.md)
