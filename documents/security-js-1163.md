# PassShare: original1163 の JS 5件の有限修正

対象の基準コミットは `f60c927561c1a8b2337ee2b24ef5e54d59171e94`。Rust、共有コード、WASM、UI、依存ロックを変更しない。アラートの抑制・除外・dismissal・GitHub設定変更は行わない。

## 分類と修正根拠

番号は保存済み `main-security-open-full.json` の最新インスタンスに従う。依頼文では2と3の経路が逆だが、メタデータの2は `/health/db`、3は `/metrics`。

| 番号 | 分類 | 実害と対応 |
| --- | --- | --- |
| 38 | 実在する計算量の問題。リモート攻撃の到達性は未立証 | SDK の `/\/+$/` は長いスラッシュ列の後ろに別の文字があると各開始位置から再試行する。ライブラリ入力に長さ上限はないが通常は利用者が設定する接続先。末尾から1回走査してスラッシュだけ除き、`/v1` と途中の内容を維持する。100万文字の末尾スラッシュと、非スラッシュで終わる不正な接続先を検査。 |
| 37 | デプロイされた Node HTTP 経路の重大な ReDoS としては誤検知。解析を線形化 | 元の `^Bearer\s+(.+)$` は不正な改行入り入力で反復が重なる。ただし入力は先に `trim()` され、空白だけの末尾は残らない。Node のヘッダーサイズ上限と HTTP パーサも先に適用される。実 HTTP でサイズ超過は431、不正な CR は400となり、metrics 認証ミドルウェアに到達しないことを成功リクエストとの比較で確認。単体検査の100万文字入力は HTTP で到達する攻撃の証明ではない。区切りの空白を1回走査し、大小文字・Unicode空白・トークン内部の空白・改行拒否を維持。比較は既存の `timingSafeEqual` のままでトークンを記録しない。 |
| 2 | 実害あり（公開 DB 確認） | 認証不要の `SELECT 1` を連打でき、Pool の待ち行列を圧迫する。既存の express-rate-limit とプロキシ方針を用い、IP ごとに60件/60秒、DB 呼び出し前に429。実 HTTP で許可60件の問い合わせ数が60となり、その後の20件のバーストで増えないことを確認。 |
| 3 | 実害あり。ただし認証が必要で、処理自体は軽い | `/metrics` は RSS/uptime だけでなく実際に `SELECT 1` を実行する。任意の未認証者がDBを消費する経路ではないが、認証済み監視元の連打でPoolを圧迫しうる。認証の後に独立した60件/60秒の枠を適用。無効なトークンは404で、監視の枠もDBも消費しない。`/health` の可用性は維持。 |
| 1 | 同じヘルパーに実害のある TLS 無効化あり。指摘行単独の危険は過大評価 | 指摘された `includes("rlwy.net")` は単独では検証付きTLSを増やす側なので、悪意ある接尾辞による検証無効化にはならない。しかし先行する `includes(".railway.internal")` はパスワード・クエリ・悪意ある接尾辞でもTLSを無効化し、CA設定より先に返る。標準URLで実ホスト境界を判定し、信頼する私設ネットワーク・ループバック以外は検証付きTLSとする。pg の connectionString 解析が sslmode/証明書指定で明示sslを上書きする経路も除去。実Pool/Clientの設定消費と createApp のPool構築を検査する。 |

TLS の設定消費順序はインストール済み pg 8.22.0 の `connection-parameters.js` と `pg-connection-string` で確認した。[node-postgres の公式仕様](https://node-postgres.com/features/ssl#usage-with-connectionstring)も URL の TLS オプションが明示した `ssl` オブジェクトを置き換えることを説明している。証明書・ホスト名検証を無効化するコールバックは追加しない。`DATABASE_SSL_ALLOW_INSECURE=true` の明示的な契約は維持し、CA指定時には適用しない。

## 検証と範囲外

最終ソースでの結果:

- SDK: `pnpm --dir packages/connect-js test` に含まれる TypeScript 型検査・ビルドが成功。3テスト成功、失敗0、skip0。
- 対象backend: DB TLS / metrics認証 / 実HTTP監視制限 / Poolウォームアップの30テスト成功、失敗0、skip0。
- backend全件: `pnpm --dir backend test` は116テスト成功、失敗0。Nodeの集計は `skipped 0` だが、DBとCLIの前提がないため7つの統合テスト群はsuite単位でskipされている。内訳はcloud sync、Connect token revocation、cross-client、PostgreSQL login guard、op-cli E2E、PostgreSQL Connect API、PostgreSQL invitation accept。未実行の子テスト数を成功件数に足さない。
- backendの `migrate:verify` は成功。静的なスキーマ検査で、実DBの接続検査ではない。backendには独立したJSビルド・型検査コマンドはない。
- 初回backend全件は114テスト中112成功・2失敗。`PASSSHARE_MUTATIONS_BIN` 未指定により招待発行が503となり、続くメンバー数検査も失敗した。最終実行では必要な実バイナリを指定して両方成功した。初回と最終の間にHTTPパーサ検査とpg環境変数検査の2テストを追加したため、全件数は116になった。

実バイナリは [基準コミットの成功CI実行 38090106841](https://github.com/AutoDevJapan/PassShare/actions/runs/38090106841) の `native-mutations-windows-latest` を使用。GitHubの実行メタデータで同じリポジトリ、mainへのpush、ワークフロー `.github/workflows/native-mutations.yml`、成功、SHA `f60c927561c1a8b2337ee2b24ef5e54d59171e94` を照合してから取得した。artifact IDは11683787540、実行ファイルのSHA-256は `8efddfa28829446ba0833931eb449f3d0cd782e5bcc7c778af1cb8814449256b`。変更していないRustソースの再ビルドはPCの空きメモリ不足で共有ゲート待ちになったため、自分の待機プロセスだけ停止した。root Cargo・全workspaceのビルド/テストは実行していない。

別のOAuth GPT-5.5による読取専用差分レビューで、`sslnegotiation=direct` がpg内部で `ssl=true` を作ってCAを消すMustが1件見つかった。これもURLから除去し、接続方式をPoolの独立した設定に渡して、実pgの消費テストに追加した。修正後の追加差分レビューはMustなし。不正な環境変数の方式名はTLS不要の接続でも拒否するため、「環境変数の影響を受けない」という文書の表現は「接続方針を上書きできない、不正値は拒否」に修正した。レビュー結果と失敗ログを含む実行記録は、作業コピーの `backend/test-results/security-js-1163/` に保持する（Git追跡の対象外）。

実DBや本番TLS接続はこの子ジョブでは行わない。Pool の検査は実pgの解析を使い、通信だけを差し替える。監視制限の検査は実HTTPと問い合わせカウンターを使う。

保存済み基準時点のopenは66件（JS 5件、Rust 61件）。これは修正後のGitHub再解析結果ではない。Original22の残作業・Rust61の読取専用分類は親担当の範囲に残し、この子ジョブから完了扱いしない。push・PR・マージは行わず、GitHub上のアラート状態は変更していない。
