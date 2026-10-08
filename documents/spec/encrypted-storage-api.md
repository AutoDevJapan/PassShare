# 暗号文保存API（M4の接続契約）

共有ToDo #1163 / #1175。これはサーバー保存部分の契約であり、全製品の暗号化完了ではない。
サーバーへ送るのは既存Coreの `EncryptedItem` だけとする。
鍵・復号済みの項目・鍵を導出するパスワードはこのAPIへ送らない。

## 分離と切替

既存ボックスは `compatibility` のまま。全クライアント未接続の状態で本番を一括切替しない。
所有者が空のパスワードボックスを明示的に有効化すると `encrypted` になる。
平文項目があるボックスは409で拒否し、原本を保持する。
既存平文の移行、解除・削除、鍵更新・配布・復旧はこの契約に含めず、未実装として維持する。
名前・ボックス識別子・項目識別子・版・鍵世代・更新時刻は公開メタデータである。
項目のタイトル・種類・フィールド・添付情報などの本文は暗号文内に置く。

PostgreSQL専用。メモリ保存や既存の平文ストアへの代替保存は行わない。
ボックス状態と暗号文の両テーブルに `connect_vaults` の外部キーと連鎖削除を指定する。
暗号文にはボックス状態への外部キーと連鎖削除も指定する。
退会処理で本人だけのボックスを削除すれば暗号文も消え、残す共有ボックスの暗号文は保持される。
別Mapのメモリ保存・専用のpurge hookは存在しない。
既存のユーザー・セッション・確認済みメンバーシップを利用する。
有効化は所有者のみ、書込みは所有者または確認済みメンバーのみ。
毎回のDB操作でセッションとメンバーシップを再確認し、共有ロックを取る。
Cookieでの変更はCSRFのCookie/ヘッダー一致が必要。
クライアント種別のヘッダーだけでCSRFを省略しない。
モバイル等のBearer認証はConnectトークンではなく、既存のセッション用トークンを利用する。

## HTTP契約

登録先は `/api/encrypted`。

| 操作 | 相対パス | 本文・応答 |
|---|---|---|
| GET | `/boxes/:boxId` | `{mode,keyEpoch}`。互換状態では世代null |
| POST | `/boxes/:boxId/enable` | `{keyEpoch:1}`。同じ有効化の再送は成功 |
| GET | `/boxes/:boxId/items?after=:itemId` | `{items:[{itemId,itemVersion,keyEpoch}],nextCursor}`。最大100件、ID順 |
| GET | `/boxes/:boxId/items/:itemId` | 保存した `EncryptedItem` の全JSON |
| PUT | `/boxes/:boxId/items/:itemId` | `{expectedVersion,envelope}`。成功は200で保存した全暗号文を返す |

新規保存は期待版0・送信版1。更新は現在版n・送信版n+1。
期待版はJSONで正確に表せる整数（0〜9007199254740990）。
暗号文は `format:1`、contextのボックスID・項目IDがURLと一致し、版が期待版+1、世代が現在世代と一致すること。
nonceは24バイト、暗号文は16〜1048592バイトのcanonical標準Base64。
未知フィールド、平文の付加、未知形式、過大本文、URLと異なるID、範囲外の数値は400。
送信版の不一致は400。DBの現在版と期待版の不一致は409 `PS015`。
現在世代と異なる世代は409 `PS056`。このAPIで世代を勝手に上げない。
JSONの鍵順・空白は保存時に正規化されるが、各値と暗号文は保持する。
同時に同じ期待版を送った場合は1件のみ成功。再送は409になるので、GETで保存済み暗号文を確認する。
切替前の暗号文保存は409 `PS055`。未認証401、権限不足403、対象なし404。
保存サービスが使えなければ503とし、平文への代替保存は行わない。

サーバーは公開ヘッダーとDB状態しか検査できない。
正しい長さの暗号文が改変されても、鍵を持たないサーバーはAEADの正当性を判定できない。
クライアントはGETの応答をCoreの `decrypt_item(envelope, expectedContext)` で検証してから利用する。
期待するボックス・項目・版・鍵世代を応答だけから信用しない。

## ホスト側の平文制限

有効化したボックスはホストの旧 `/v1/vaults/:vaultUuid` 経路から拒否する。
Expressのパラメーターで判定するので、大文字・末尾slash・URLエンコードによる別経路を許可しない。
一覧・詳細・編集フォーム・添付・1PUX取込を含む。
互換ボックスの旧経路を一律に禁止しない。

DBの旧項目INSERT/UPDATEにも境界トリガーを設ける。
旧書込み・切替・暗号文操作は同じ親ボックスの行ロックで直列化される。
先に平文書込みが成功すれば切替を拒否し、先に切替が成功すれば平文書込みを拒否する。
トリガー拒否はSQLSTATE `P0055`。親のHTTPエラー接続はこれを409 `PS055`へ変換する。
このエラー接続がない場合でもDBは書込みを拒否するが、旧経路の競合時のHTTPは500となる。

## 親担当へ渡す接続変更

この独立作業は既存認証router/store・パスワード処理を編集しない。
親は起動後のpool/authStoreを使って `createEncryptedRouter({pool,authStore})` を生成する。
poolとnative実行ファイルがあるときだけスキーマ・APIを登録し、poolのない開発用既存経路を壊さない。
新APIを登録しなかった環境では未対応として扱い、暗号化済みと表示しない。

1. `app.js`へ新routerと境界routerをimportする。
2. JSON parserの後に `/api/encrypted` を登録する。
3. Connect認証の後・旧Connect routerの前に `/vaults/:vaultUuid` の境界routerを登録する（/v1にRouterを作ってもよい）。
4. HTTPエラーハンドラーで `P0055` を409 `PS055`へ変換する。
5. production nativeはCoreへ依存しないので、現行backend-onlyのDockerfile・Railway rootDirectoryを維持する。
6. 専用受入は `tools/encrypted-storage-acceptance` の独立Rust workspaceから実行する。
   Coreとnativeへのpath依存・本物の暗号化と復号はこのtoolだけに置く。
   親が専用toolのCIを登録する。成功済みのルート全workspace検査を繰り返さない。

`backend/src/encrypted/acceptance-host.js` は上記登録を実APIで検証する薄い専用ホスト。
架空データ・Dockerの起動終了・全判断と検査はRustの独立toolに置く。
共有Cargoゲート内で動かし、専用DBと自分のNodeを終了時に回収する。

## 実受入と残条件

専用受入はCoreで生成した全JSONを暗号化し、実HTTP PUT/GET・DB保存後・再起動後に同じ鍵で復号する。
形式/ID/版/世代の拒否後に元の暗号文が変わらないこと、4件の同時更新で成功1/競合3、
他アカウント・失効済みメンバー・失効済みセッションの拒否、CookieのCSRF拒否、
旧ホスト経路とDB直書込みの拒否、互換ボックスの既存項目保持を検査する。
未確認メンバーの拒否と確認済みメンバーの読取り、平文書込みと切替の競合、
本人だけのボックスを削除したときの二段階の連鎖削除と他ボックスの保持も検査する。
毎回新しい専用DBを作り、登録は合計5件だけとする。既存の登録上限を変更しない。

2026-10-08のWindows実受入では上記すべてが成功した。
Coreを独立toolへ移した最終構成でnativeのnextest38件、toolのCore契約nextest2件が成功した。
両workspaceのClippyは全target・警告0で成功し、新toolから実HTTP/PGの全受入も成功した。
Core・ルートmanifestのないbackend-onlyの別配置で、production nativeのlocked release buildも成功した。
これはWindowsの配布配置検証で、LinuxのDockerイメージ実buildの確認ではない。
独立作業では全workspace検査・push・PR・CI・別モデルレビュー・マージを行わない。
親が最終統合の検査とレビューを実施する。

全クライアント接続・端末鍵保管・WASM・共有鍵配布/失効/復旧・移行と原本保持・
暗号化添付・プラン上限・削除契約・本番での統合/CIは未完。
サーバー契約の受入成功をM4全体や販売条件の完了に読み替えない。

## 親へ渡す具体的な接続差分（2026-10-08補足）

### DB・公開経路・realm

実検証はDockerのPostgreSQL 17 Alpine。MySQL・SQLite・DBのモックは使わない。
接続は既存Nodeのnode-postgres `pg` 8.22.0のPool。Rustは標準入出力で検査とSQL計画を返し、
JSがPoolでパラメーター化SQLを実行する。Rustの別DBdriver・別DBserviceは追加しない。
実接続は使い捨てDBの127.0.0.1の動的ポート。モデルや本番のAPIキーは使わない。

バックエンドの標準登録先は `/api/encrypted/boxes/...`。
現在のVercel設定に従う統合後の予定公開先は
`https://pass-share.bm1314.net/backend/prd/api/encrypted/boxes/...`。
開発・検証は同じ `/backend/dev`・`/backend/stg` の中継先へ登録する。
これはリポジトリのrewrite設定に基づく予定URLで、新APIの公開環境の開通確認ではない。
新APIはセッションCookieまたはセッションBearerを使い、旧 `/v1` のConnect Bearerと区別する。

realmという設定・request欄・WWW-Authenticate realmは実装していない。
DB環境の分離に加え、既存sessionのUUIDとuser UUID、確認済みmembership、ボックスIDで権限を決める。
Coreの項目AADは用途名 `passshare.cloud.item`・形式・ボックスID・項目ID・版・鍵世代。
そこへAPP_ENV・配信origin・環境realmは入らない。
別環境へ同じDB、ID、鍵、sessionを複製した場合の暗号上のrealm分離は保証しない。
入力へrealmを付けても新たな権限・鍵区分にはならず、PUT/enableの未知フィールドとして拒否する。
環境realmを追加する製品要件があるなら、Core形式・AADと全クライアントを別途整合させる必要がある。

### `backend/src/app.js`

importを1つ追加する。

```js
import { createEncryptedRouter, createPlaintextBoundary } from "./encrypted/router.js";
```

既存JSON parserより後の登録部分を次の形に接続する。
親の復旧・退会登録はそのまま保持する。

```js
const mutateOnce = await createMutationStore({ store: connectStore, authStore, pool });
app.use("/api/auth", createAuthRouter({ authStore, connectStore, appEnv, loginGuardStore, mutateOnce }));
const encryptedRouter = pool && process.env.PASSSHARE_MUTATIONS_BIN
  ? await createEncryptedRouter({ pool, authStore }) : null;
if (encryptedRouter) app.use("/api/encrypted", encryptedRouter);

const connectApi = express.Router();
connectApi.use(createRequireConnectAuth({ authStore, appEnv }));
if (encryptedRouter) {
  connectApi.use("/vaults/:vaultUuid", createPlaintextBoundary({ pool }));
}
connectApi.use(createConnectRouter(connectStore, { requireVaultAccess, mutateOnce }));
app.use("/v1", connectApi);
app.use(connectErrorHandler);
```

境界をConnect認証の後・旧routerの前に置く。メモリ専用起動では新APIを登録しない。
新API初期化の失敗を無視して通常起動するcatchは置かず、原因を修復する。
初期化によるスキーマ追加だけでは、既存ボックスのモードは切り替わらない。

### `backend/src/middleware/connect-errors.js`

`connectErrorHandler` のheadersSent判定の後、一般のstatus判定の前へ追加する。
旧Connect APIの標準応答形式 `{status,message}` を維持する。

```js
if (err && typeof err === "object" && "code" in err && err.code === "P0055") {
  sendConnectError(res, 409, "PS055: Ciphertext storage required");
  return;
}
```

この翻訳は、旧要求が境界確認を済ませた後に別要求で有効化された競合のために必要。
独立受入の旧routerにはまだ翻訳がないので、その競合スケジュールでは500でもDB拒否を合格としている。
親の正式統合後は、そのスケジュールも409になることを検査する。

### backend-only配布と独立受入tool

先のルートbuild context変更案は取り消す。
production nativeのCore依存を除いたため、現行 `backend/Dockerfile` の
`WORKDIR /native`・`COPY native ./`・`cargo build --release --locked --bin passshare-mutations` を維持する。
CIの `docker build -t passshare-todo1163-api backend` も変更不要。
Railwayのbackend-only文脈・rootDirectory・Dockerfile参照先を変更しない。
公開中の配布を別のルート配置へ移さない。

nativeは公開JSONの厳密なfield集合・整数型/範囲・26文字の小文字英数字ID・
context一致・canonical標準Base64・nonce/暗号文長だけを検査する。
項目の暗号化アルゴリズム、鍵操作、復号、Coreのコードコピーは含まない。
native単体fixtureは公開ヘッダーと合成暗号文のみ。
スキーマのinclude_str!とbuild.rsの変更検知は維持する。

本物の暗号化・復号受入を `tools/encrypted-storage-acceptance/src/main.rs` へ移す。
toolのCargo.tomlは独立workspaceであり、Coreとpassshare-mutationsへpath依存する。
ルートworkspaceのmembersやCoreソースは変更しない。
独立toolのCargo.lockを保存し、production nativeのCargo.lockとは分ける。
production nativeのlockはCore関連を除いて22 packages、tool側は93 packagesとなる。

toolの単体契約試験は、Coreが作った本物の暗号文をnativeのdispatchへ渡して
項目/世代の整数上限、Coreの1MiB本文境界、暗号文の長さ上限を照合する。
Coreの復号成功も確認し、余分な鍵/平文/realmや型違いをnativeが拒否する。
これはSSOTの暗号アルゴリズムを複製せず、公開保存契約との整合を検査するための試験。
実HTTP受入は別途ビルドしたproduction native実行ファイルを使う。

専用targetを2つ用意し、共有Cargoゲートから次の順で実行する。
例のパスは自分で所有記録を付けた作業用一時フォルダ配下に置く。
Windowsはproduction実行ファイル名に .exe を付ける。

```sh
cargo nextest run --manifest-path backend/native/Cargo.toml --locked -p passshare-mutations --target-dir /owned/native-target -j 10
cargo clippy --manifest-path backend/native/Cargo.toml --locked -p passshare-mutations --all-targets --target-dir /owned/native-target -j 10 -- -D warnings
cargo build --manifest-path backend/native/Cargo.toml --locked --bin passshare-mutations --target-dir /owned/native-target -j 10
cargo nextest run --manifest-path tools/encrypted-storage-acceptance/Cargo.toml --locked -p passshare-encrypted-storage-acceptance --target-dir /owned/tool-target -j 10
cargo clippy --manifest-path tools/encrypted-storage-acceptance/Cargo.toml --locked --all-targets --target-dir /owned/tool-target -j 10 -- -D warnings
cargo run --manifest-path tools/encrypted-storage-acceptance/Cargo.toml --locked --target-dir /owned/tool-target -j 10 -- /owned/native-target/debug/passshare-mutations
```

nativeとtoolのtargetを共有しない。nextestの試験並列も10以下とする。
rootの全workspace nextest/docは親が成功済みなので再実行しない。
親はAPIの正式app登録、旧経路の境界、P0055のHTTP変換と専用toolのCIを担当する。
専用toolはDocker/Node/バックエンドの依存導入済み環境で実行し、専用DBを自動起動・回収する。
配布Dockerfileや本番の起動entryにこの受入toolを入れない。

### 検証の正確な範囲

実HTTPは正式実装の新router＋既存signup/session/Connect APIを実行した。
スコープは専用 `acceptance-host.js` から接続する受入用API。
画面プレビューやmock APIではないが、正式 `src/index.js` の起動経路への新router登録でもない。
受入ホストは外側に新APIと旧境界を置くため、旧境界はConnect認証より先に実行される。
親の正式登録では上の順番へ直す。専用ホストを公開用起動entryへ変更しない。
Vercel中継、正式セキュリティヘッダー/CORSの適用順、実配布Dockerimage、公開dev/stg/prdの新API、
realm分離、既存ユーザーの平文移行、全クライアント・鍵復旧の成功は、この独立受入では確認していない。
架空fixtureは専用PGを毎回作って5ユーザーだけ登録し、既存の30件登録枠を緩和しない。
