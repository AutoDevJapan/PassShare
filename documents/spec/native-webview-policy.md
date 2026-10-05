# 端末画面のコードと通信の制約

ToDo1197・1176、Issue409。画面の形は変えず、デスクトップとモバイルの `csp: null` を修復する。

実装された画面は、同梱したスクリプト・CSS、MatrixBackgroundのstyle属性、アセット・data画像、TauriのIPC、設定したHTTPS APIと開発用のloopback HTTPを使う。外部のスクリプト、nonceなしのinline script、eval、埋め込みのobject・frameは必要ない。これらを同梱するコードとは分けて制約する。style属性の許可をscriptの許可へ広げない。

[TauriのCSP仕様](https://v2.tauri.app/security/csp/)に従い、同梱したコードへのnonceとhashはTauriが生成する。遠隔APIのHTTPS接続は設定可能な機能として維持し、平文HTTPはloopbackに限る。任意のHTTPSホストを接続可能としていても、そのホストのコードを読み込む許可にはしない。

受入は設定ファイルの値の検査だけで終えない。[公式のネイティブWebDriver方式](https://v2.tauri.app/develop/tests/webdriver/ci/)を、架空データとRustの有限実行器で使う。

1. 両方の本体を旧null設定でビルドし、実WebViewで画面・style属性・loopbackを確認する。挿入したinline script、外部script、evalが実行される旧状態を記録する。
2. 元の設定をバイト一致へ戻して本体を再ビルドし、同じ操作を拒否する。外部scriptは取得要求自体が出ないことをloopback側で照合する。必要な表示と通信は成功する。
3. デスクトップの実IPCで架空のパスワードボックスを作成し、実ファイル置換の失敗・メモリ保持・一回再試行・施錠・再読込を確認する。Web版の代替画面や直接Core呼出しの結果へ置き換えない。
4. 両方の実画面をPNGで保存する。CIの仮想画面はCPU描画と専用の空のデータ領域を使い、オーナーのPC・アカウント・ブラウザの記録を読まない。所有するdriverの子孫と架空データを回収する。

この検査はLinuxの実ネイティブWebViewで、モバイル用の画面も通常のLinuxウィンドウとして実行する。Android/iOSの実端末、macOS/Windowsの実WebView、開発時のVite接続、背景・アイドル終了、アカウント復旧、署名・更新の検証は別に必要であり、M6/M7全体を完了としない。UIの新しい見た目を提案する変更ではない。
