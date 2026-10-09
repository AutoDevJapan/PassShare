# API 配布イメージの依存固定（2026-10-04）

API の配布イメージを、CI が検査する `backend/pnpm-lock.yaml` から作るよう修正した。イメージ内で既存 API テスト44件が成功した。これは販売前改善1197・配布検証1176の一部であり、実配備や製品全体の受入完了ではない。

## 問題と修正

基準 main は `6525462471191fe917a00c28e6256843bfb7a747`。Railway の設定は `backend/Dockerfile` を使用するが、そのファイルは package.json だけをコピーして `npm install --omit=dev` を実行していた。CI は pnpm の固定依存一覧を使うため、検査対象と出荷イメージの依存が一致する保証がなかった。npm の依存一覧を更新して第二の正本を作る方式は採用していない。

Dockerfile は package.json と pnpm-lock.yaml をコピーし、指定の pnpm 10.11.0 で `--prod --frozen-lockfile --ignore-scripts` を実行する。アプリのソース、既存の起動コマンド、Railway 設定は変更していない。Quality Gate の Backend ジョブでもこの配布イメージをビルドし、イメージ内の製品ソースと本番依存を使って既存の HTTP テストを実行する。テストだけを読取専用でマウントする。

## 実施した確認

[実測記録](evidence/1342-backend-image.json)に対象 Dockerfile・依存一覧のハッシュと検査範囲を保存した。原ログは `D:/CC/Work/passshare-orch-20261004-232500/` に保持する。

| 確認 | 結果 |
|---|---|
| 正式 Dockerfile のビルド | 成功。pnpm 10.11.0、production 依存108パッケージを固定依存一覧から導入 |
| イメージの直接依存 | argon2 0.44.0、express 5.2.1、fast-json-patch 3.1.1、pg 8.22.0、unzipper 0.12.5 の5件が依存一覧と一致 |
| 既存 API テスト | 認証、モバイル・拡張認証、項目 CRUD、添付、1PUX、セッション、CSRF、HTTP ヘッダーの44件が成功。失敗・省略0件 |
| native argon2 | イメージ内の既存 signup/login テストが実際にハッシュ作成・照合を実行して成功。依存スクリプトを停止しても今回の Linux イメージで動作 |
| 正式起動 | Dockerfile の既存 `npm start` で8080番の待受ログと稼働状態を確認。公開ポートなし、ネットワーク none |
| 依存一覧の不一致 | コンテナ内の使い捨てコピーで express の要求版だけを変更。`--frozen-lockfile --offline` が `ERR_PNPM_OUTDATED_LOCKFILE`・終了1で拒否 |
| 後片付け | 自分の検証コンテナとイメージのタグを削除し不在を確認。専用ボリューム・ネットワークは作成していない |

実行コマンドは `docker build --tag passshare-1342-backend-lock:verify backend` と、同イメージの `node --test` に次の既存7ファイルを指定したもの。テストは全てコンテナ内 HTTP とメモリストアを使用する。

```text
test/auth-api.test.js
test/mobile-auth.test.js
test/extension-auth.test.js
test/connect-api.test.js
test/connect-api-extended.test.js
test/security-headers.test.js
test/web-session.test.js
```

不一致検査の初回は、補助コピーを読取専用にしたため pnpm の一時ファイル作成が EROFS で失敗した。これは依存一覧の検査に到達した証拠ではない。原ログを保持し、使い捨てコンテナへコピーする方式で再検査して上記の拒否を確認した。製品の manifest と依存一覧は変更していない。

## 残る確認

- この検査はメモリストアを使う API の検査。PostgreSQL を使う復元、実画面、正式 SDK、全クライアント、Railway の配備結果を証明しない。
- ベースイメージの指定は従来の `node:24-bookworm-slim` のまま。今回の digest を記録したが、ベースイメージまで固定したという主張はしない。
- 別モデルによる全差分レビューと、この変更を含む最新 CI、マージ後の main 検査が必要。必須改善 M1–M8 と1176全体は1197で継続する。

## 2026-10-10: ベースイメージの取得制限を修復

上記は2026-10-04時点の記録。PR679の最初のCIでは、Docker Hubが `node:24-bookworm-slim` の取得にHTTP 429を返し、配布イメージのビルドとBackend検査が開始前に失敗した。

現在のDockerfileは、[Googleの公式Docker Hubキャッシュ](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images)から、直前に受入検査が成功したDocker Official Imagesと同じインデックスdigestを取得する。Rustは `sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6`、Nodeは `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` に固定する。依存一覧、製品のソース、起動方法はこの取得先の修正で変えていない。

修正後の正式Dockerfileによるビルドは成功した。Linux amd64の実行イメージのconfig digestも修正前と同じ `sha256:68fa98cacf85553fe1c2a18072a788fffb1d0b537bb4f36587a8f5fdc8145649` だった。原ログは共有ToDo1163の作業記録 `D:/CC/Work/passshare-finish-1163-20261010/` に保存する。CIとマージ後のmain検査は、それぞれ最新ソースで別途確認する。キャッシュからの取得成功を、暗号化の全アプリ接続や製品全体の受入成功とは扱わない。
