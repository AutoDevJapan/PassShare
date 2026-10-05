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
- 最初のstandaloneのmain基準 `frontend tsc --noEmit` は失敗した。未使用csrf、favoriteの生成型、searchSectionsの参照、sharedのReact/SDKの解決、pluralの型を含む。以下の型修復後には、このPR単独で型検査とbuildが成功した。mainでの成功は未確認。
- RustのTLS依存rustls 0.23.40はRUSTSEC-2026-0285で未修復。互換な修正版0.23.45以上への更新・Cargo audit・関連検査は、既存ToDo #1176のCargo割当で最初に実行する。この担当ではCargoを起動せず、Cargo.lockを手で書き換えない。

原mainの失敗、初回試行、4監査JSONと3試験logは `D:/CC/Work/passshare-orch-20261005-063759/` に保存した。原PR #595のレビューは保全する。Rustの最終差分と型修復を合わせた候補の別モデルレビュー、最新全CI、mainの監査実成功まで #1560 / #1342 / #1197 は未完了。#1556の翻訳と原1515 / 1540 / 1558の固定レビュー対象を変更しない。

## PR単独の型修復（2026-10-05、親1197の継続）

PR #592は二重作成の修復1482を待つため、この依存修復の検証をPR #592全体のマージに依存させない。既存修復 `4f540afc` / `59ce6ad6` から、型検査に必要な6ファイルの修復だけを取り込んだ。本人切替、編集・再送、画面の説明と翻訳の差分は取り込んでいない。原1515 / 1540 / 1558の指定HEADとレビュー対象を保持する。

- 読まれないCSRF変数と代入だけを除去。変更要求ごとのCSRF取得と `X-CSRF-Token` 送信はそのまま。
- searchSectionsの型参照を既存の共有パスへ接続し、ReactとSDKの型解決を既存修復と一致させた。
- pluralの `one` を任意にし、その分類がない言語では既存の `other` を使う実装と型を一致させた。
- `favorite?: boolean` は既存SDK生成器の修復を取り込み、正式な `pnpm --dir backend generate:types` から生成した。生成物を手書きしていない。
- Quality GateのWeb工程へ `pnpm --dir frontend exec tsc --noEmit` を追加し、SDKのビルドとフロントの導入後に実行する。

同じPRの修復前で型検査のexit 1を再現した。修復後はSDK build / SDKの既存1試験 / frontend tsc / build / i18n（10言語267キー）/ 日本語UI検査7項目 / `git diff --check` がexit 0。既存APIの認証・Cookie/CSRF・Mobile/Extension・Connectを対象とする7ファイル32試験も失敗・省略0で成功した。このAPI試験は架空のメモリストアを使い、PostgreSQLや実画面、退会・本人確認の完成を証明しない。frontendの再監査は全severity 0・exit 0。

初回buildはSDK build前のfrontend導入により、コピーされたSDKにdistがなく失敗した。SDK build後に同じoffline / frozen / ignore-scripts導入を行い、distの存在とbuild成功を確認した。CIはもともとこの正しい導入順序である。初回失敗ログも保全した。最終JSは446.87kB / gzip117.52kBで、これは翻訳PR未統合のサイズである。

今回の実行記録は `D:/CC/Work/passshare-orch-20261005-095510/`。CargoとRust依存の更新は実行していない。Rust修復1176の割当後に最新親HEADから最小lock修復を受領し、最終全差分の別モデルレビュー、最新全CI、マージ後の同じmain SHAの実監査と受入を確認するまでDraftを維持する。
