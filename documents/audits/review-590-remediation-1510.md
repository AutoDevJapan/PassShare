# 販売説明の別モデル指摘への修正（1197 / 1510）

レビュー1183が固定dd5855bに指摘したMustを修正する。端末版の.pboxで使うマスターパスワードと暗号化をHeroで明示し、クラウドではアカウント認証を使いサーバーが項目内容を読めると説明する。比較表の機能名と暗号化欄にも同じ条件を表示する。

ja/en/ruに加え、英語文を流用していた他8言語にも同じ誤認があったため合計11言語のHeroを修正した。新しい翻訳対応を主張しない。中腹の固定日本語（監査S2）とクラウド暗号化の実装1175は未完のまま。

検査: pnpm --dir packages/connect-js install --offline --frozen-lockfile --ignore-scripts、同build、pnpm --dir frontend install --offline --frozen-lockfile --ignore-scripts、exec tsc --noEmit、buildが成功。初回はrootだけに依存を導入してSDK/Webのtsc/viteが不在、各packageの依存導入で修復した。製品の依存やlockは変更しない。

root/frontendにquality-gate/check-types/format:check/lintコマンドがないため、既存tsc/buildとGitHubQualityGateを確認する。Cargo/全client/配布/販売可はこの修正の成功に含めない。更新HEADの全差分を既存1183で再レビューし、Must0と最新CI後に統合する。

原結果・補助・コマンドはD:/CC/Work/passshare-orch-20261005-043725に保持。原レビューを削除しない。
