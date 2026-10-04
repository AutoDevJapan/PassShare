# アカウント切替後の下書き修復（1197 / 1510）

固定df8c53aへの別モデル1183のMust1件を実Chromeで再現して修復した。本人情報を取得した直後に既存user stateへ接続し、Connect tokenの取得失敗が新しい本人情報を捨てないようにした。ItemsPageの既存利用者ID/ボックス変更時のフォーム破棄を再利用する。新しい判断ロジックや永続保存は増やさない。

## 再現と修復の受入

正式backend/Dockerfileは未マージ36b2dd8のbackend（本修正と同じbackendソース）、PostgreSQL16固定digestの架空専用DB、APP_ENV=stg。DB/APIに公開ポートなし。私有Go HTTP中継のみ127.0.0.1:5189で、正式Web signup/session/CSRF/dynamic Connectのままtoken取得だけ503を注入した。認証値は記録しない。

オーナーChromeのMasashiプロフィールで今回新規2タブを使用。2人の架空利用者を正式登録し、別タブでログアウトとログインを行った。

- Red: 原df8c53aのbuildで、Bへ切替後の本人情報取得に続くtoken GET4試行が503。元タブはAのメールと未保存のタイトル/メモを残し、フォーム無効のまま旧下書きを表示した。
- Green同一利用者: 修正buildでAのtoken GET4試行が503になってもタイトル/メモを保持し、送信無効。障害解除後の一覧更新で編集可能となり、同じ下書きを保持した。
- Green別利用者: 修正buildでBへ切替後のtoken GET4試行が503。元タブはBのメールを表示し、Aのタイトル/メモは空。フォームは無効で、旧ボックス名も消えた。
- 正式ログアウト後は検証セッションを終了。検証用の2タブは閉じた。

上の3条件は手動の実画面受入で、自動E2E suiteの成功件数ではない。RedとGreenは同じGo中継/正式API/DB。counterは累積4/8/12で、条件間の差4を保存した。ログアウト後の画面遷移を待たずgotoした一度は切替が完了せず、画面でログアウト完了を確認してから再実行した。認証失敗の原因をCSRFと断定しない。

説明修正4f540afを元592へ無競合でmerge。auth修正の12行以外は590説明の統合と本Spec/監査。最新結合buildでja/en/ruのHeroが端末.pboxとサーバー可読のクラウドを区別し、比較表も同じ条件を表示する。中腹の固定日本語S2は未完。

検査: SDK/Webそれぞれpnpmのoffline/frozen/ignore-scripts依存導入、SDK build、frontend exec tsc --noEmit、build、root i18n:check、git diff --checkが成功。初回はrootだけに導入してtsc/viteが不在で失敗し、各packageの導入へ直した。品質ゲートの指定scriptは原packageにないため、既存型/buildと最新GitHubQualityGateで確認。Cargo/全client/旧API不明応答/全22条件の合格ではない。

証跡はD:/CC/Work/passshare-orch-20261005-043725。Go中継ソース、原失敗build、Red/Green counter、source/生成物hashと検証記録を保持。原1183レビューの判定とSHAは変更しない。更新HEADの全差分を別モデルで再確認し、全CI成功後に統合する。二重作成1482は継続し、592を無条件mergeしない。
