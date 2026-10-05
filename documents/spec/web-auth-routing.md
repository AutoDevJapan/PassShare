# Web認証の同一サイト経路

Issue613 / 共有ToDo1177、2026-10-06。

正式WebからRailwayへの直接要求では、ChromeがCSRF CookieをSchemefulSameSiteLaxとして拒否し、登録が403となった。APIの直接検証の成功だけではWebの成功を示さない。

Webの既存API_BASE設定を同じサイトの相対接頭辞へ変え、既存Vercelの外部rewriteで正式Railwayへ中継する。新しいサーバー、アカウント、権限、レイアウトは追加しない。CookieのSameSite・Secure、CSRF、バックエンドの認証を維持する。

| Vercel対象 | VITE_API_BASE_URL | 転送先 |
|---|---|---|
| production | /backend/prd | 正式production backend。本番ホストpass-share.bm1314.netにだけrewriteを許可 |
| stgブランチpreview | /backend/stg | 正式staging backend |
| その他preview / development | /backend/dev | 正式development backend |

APIの/api/authとConnectの/v1は同じ接頭辞へ送る。環境の同期設定も相対接頭辞へそろえ、後続の同期で絶対URLへ戻さない。本番の同じサイトCookieは他のpreviewホストに共有されない。APIの応答をキャッシュしない。

Given架空のWeb利用者 / When同じサイトから登録・作成・再読取・ログアウト・再ログイン / Then画面と正式APIが同じ利用者・項目を示し、旧資格は拒否する。Givenpreviewホスト / When本番接頭辞へ要求 / Thenproduction DBへ転送しない。

Rustの構成検査は、環境別の正式転送先、相対設定、本番ホスト条件、SPAより前の経路、no-storeを固定する。ホスト条件を除いた変異が境界検査で拒否されることを含む。固定候補CI、別モデル、実Chromeと架空データの回収後に合格とする。予定を成功にしない。

参考: https://vercel.com/docs/routing/rewrites
