# mainの依存監査の修復（ToDo #1560、親 #1197）

PR #595の固定 `35a59800` を全4ファイルの別モデルレビューで確認し、Must 0件・GitHubレビュー5408397423・PR checks終了後にmainへ統合した。main `eba72ca0` は指定した2親と事前のtree `0882bef28ebf8e0c9b870d5282be82d881e19f0c` に一致した。しかしSecurity Audit 37238153852はRust 1工程と画面4工程で失敗した。PRでは監査stepの失敗を `continue-on-error` が許容していたため、jobが成功表示でも実監査の成功ではなかった。

## 原因と修復

画面4パッケージに既存pnpmのoverridesで修正版を固定し、通常のlock解決を行った。直接依存の範囲、React / Vite / Tauriの版、相対パッケージパスは保持する。

| 依存 | 修復前 | 修正版 | 範囲 |
|---|---|---|---|
| react-router / react-router-dom | 7.18.1 | 7.18.2 | frontend |
| nanoid | 3.3.15 | 3.3.18 | frontend / desktop / mobile / extension |
| postcss | 8.5.16 | 8.5.28 | 同4パッケージ |
| esbuild | 0.28.0 | 0.28.2 | extensionの既存tsx依存 |

Security AuditのPRだけの失敗許容3箇所を外した。PR、main、夜間実行で実監査の失敗を検出する。監査基準と既存警告の扱いを緩めない。今後はjobの成功表示に加えて監査stepの実結果を確認する。

最初のpnpm updateは指定した推移依存が直接依存に存在しないパッケージで対象外まで更新した。試行patchを保全し、この担当が作った8ファイルの差分だけを戻して、上記の最小override方式へ変えた。npm viewは共用cacheのENOENTとnpm/Node版の警告で失敗したため、共用cacheを変更せず公式registryのHTTP応答から版を確認した。PostCSS 8.5.18は別の未修復の注意情報が残ったため、同じ8.5系の現行修正版8.5.28へ変更した。初回失敗のJSONを保持した。

## 実検査と未完条件

- 最終 `pnpm --dir <package> audit --audit-level=high --json` は4パッケージすべてexit 0。low / moderate / high / critical / infoがすべて0。
- 4パッケージの `install --frozen-lockfile --ignore-scripts` と `build`、SDKの導入・buildが成功した。
- 既存 `pnpm --dir apps/desktop test` は41件、mobileは15件、extensionは41件で成功。失敗・省略0。Rustと実GUIの成功件数には数えない。
- standaloneのmain基準 `frontend tsc --noEmit` は失敗した。未使用csrf、favoriteの生成型、searchSectionsの参照、sharedのReact/SDKの解決、pluralの型を含む。これは既存PR #590 / #592が保持している修復と統合して再検査する。失敗を無関係として除外せず、統合候補とmainでの成功が必要。
- RustのTLS依存rustls 0.23.40はRUSTSEC-2026-0285で未修復。互換な修正版0.23.45以上への更新・Cargo audit・関連検査は、既存ToDo #1176のCargo割当で最初に実行する。この担当ではCargoを起動せず、Cargo.lockを手で書き換えない。

原mainの失敗、初回試行、4監査JSONと3試験logは `D:/CC/Work/passshare-orch-20261005-063759/` に保存した。原PR #595のレビューは保全する。Rustの最終差分と型修復を合わせた候補の別モデルレビュー、最新全CI、mainの監査実成功まで #1560 / #1342 / #1197 は未完了。#1556の翻訳と原1515 / 1540 / 1558の固定レビュー対象を変更しない。
