import type { LocaleDocs } from "./types";

export const docsJa: LocaleDocs = {
  hub: {
    title: "ドキュメント",
    lead: "PassShare の使い方、拡張機能、法務文書、FAQ をまとめています。",
    links: [
      {
        path: "/docs/user-guide",
        title: "ユーザーガイド",
        description: "初回セットアップから日常利用まで",
      },
      {
        path: "/docs/extension",
        title: "拡張機能インストール",
        description: "Chrome / Edge / Firefox / Safari 別手順",
      },
      {
        path: "/faq",
        title: "よくある質問",
        description: "FAQ とトラブルシューティング",
      },
      {
        path: "/terms",
        title: "利用規約",
        description: "PassShare サービス利用条件",
      },
      {
        path: "/privacy",
        title: "プライバシーポリシー",
        description: "個人情報の取り扱い",
      },
    ],
  },
  userGuide: {
    title: "ユーザーガイド",
    lead: "PassShare でパスワードボックスを安全に使うための手順です。",
    sections: [
      {
        id: "signup",
        title: "1. アカウント作成",
        paragraphs: [
          "Web ポータル（/app/signup）でクラウド用のアカウントを作成します。端末版の .pbox はアカウントなしで使えます。一般向けの配布は検証中です。",
          "マスターパスワードは PassShare サーバーに送信されません。端末上でパスワードボックスを暗号化するためにのみ使用されます。",
        ],
      },
      {
        id: "unlock",
        title: "2. パスワードボックスを開く",
        paragraphs: [
          "Desktop では .pbox ファイルを選択し、マスターパスワードで開きます。クラウド用のアカウントパスワードとは別です。",
          "Webではログイン後、パスワードボックスの保管方式を確認してください。所有者暗号化モードはログイン用とは別の暗号化パスワードを使い、端末内のRust/WASM Workerで処理します。サーバーは項目の内容を読めません。Connect互換モードではサーバーが内容を読めます。",
          "所有者暗号化モードは実装済みですが、利用先で暗号化APIが有効な場合に限ります。新規設定は空のパスワードボックスが対象です。すでに項目がある互換モードからの移行と、全クライアントの暗号化対応は未完です。Desktop・Mobile・拡張機能のConnect接続を、暗号化モードへの対応とみなさないでください。CLIの明示的な暗号化モードも通常のConnect接続とは別です。",
        ],
      },
      {
        id: "crud",
        title: "3. ログイン情報の管理",
        paragraphs: ["パスワードボックス内でログイン項目を追加・編集・削除できます。"],
        list: [
          "Web: /app/vaults → パスワードボックス選択 → 項目 CRUD",
          "Desktop: 項目一覧から追加・検索・コピー（クリップボードは自動消去）",
          "Mobile / Extension: Connect互換モードの項目にアクセス。所有者暗号化モードへの接続は未対応",
        ],
      },
      {
        id: "sync",
        title: "4. クラウド同期（Desktop）",
        paragraphs: [
          "Desktopの設定 → クラウド同期から、Connect互換モードへpush / pullを実行できます。端末ファイルの暗号化は、この接続先の内容をサーバーから隠すものではありません。",
          "競合が発生した場合は、ローカル優先またはクラウド優先を選択して解決します。",
        ],
      },
      {
        id: "migration",
        title: "5. データ移行",
        paragraphs: [
          "1Password からの移行: 1PUX インポートまたは 1Password CSV エクスポート → PassShare インポート。",
          "詳細はランディングページの移行セクションも参照してください。",
          "CSV は平文です。追加フィールド・添付・複数 URL 等をすべて保全するバックアップではありません。移行後に内容を確認し、検証前に元データを消さないでください。",
          "端末の復旧対応版では、復旧が有効な .pbox ファイルと緊急キットのコードで新しいマスターパスワードを設定できます。旧ファイルは現在のマスターパスワードで事前に復旧を有効化してください。ファイルの控えとコードは別々に安全に保管します。コードだけでは紛失したファイルを取り戻せません。",
          "端末ファイルの復旧はRust Coreに実装済みです。利用中のアプリの版と配布元の機能説明で、ファイル形式と復旧操作への対応を確認してください。旧版では未対応の場合があり、デスクトップの復旧画面は統合し、Linuxの実画面で検証済みです。署名・対応OSでの導入・一般向け配布は確認中です。このガイドはダウンロード先や導入済みの証明ではありません。",
        ],
      },
    ],
  },
  extensionInstall: {
    title: "拡張機能インストールガイド",
    lead: "ブラウザ拡張（MV3）でログイン情報のオートフィルと保存提案を利用できます。",
    sections: [
      {
        id: "chrome",
        title: "Google Chrome",
        paragraphs: ["Chrome ウェブストア公開前は開発者モードで読み込みます。"],
        list: [
          "packages/extension で pnpm run build を実行",
          "chrome://extensions → デベロッパーモード ON",
          "「パッケージ化されていない拡張機能を読み込む」→ dist/ を選択",
          "ツールバーの PassShare アイコンからログイン",
        ],
      },
      {
        id: "edge",
        title: "Microsoft Edge",
        paragraphs: ["Edge は Chromium ベースのため Chrome と同様に dist/ を読み込みます。"],
        list: [
          "edge://extensions → デベロッパーモード ON",
          "「拡張機能を読み込む」→ dist/ を選択",
        ],
      },
      {
        id: "firefox",
        title: "Mozilla Firefox",
        paragraphs: ["Firefox は zip 形式の一時アドオンとして読み込みます。"],
        list: [
          "dist/ を zip 化（ルートに manifest.json がある状態）",
          "about:debugging → 一時アドオンを読み込む",
          "zip ファイルを選択",
        ],
      },
      {
        id: "safari",
        title: "Apple Safari",
        paragraphs: [
          "Safari 向けは Xcode 経由の Web Extension 変換が必要です（開発者向け）。",
          "一般ユーザー向け App Store 版はストア公開後に本ページを更新します。",
        ],
        list: [
          "documents/runbooks/extension-store-release.md の Safari 節を参照",
          "開発ビルド: packages/extension/dist を Safari Web Extension に変換",
        ],
      },
    ],
  },
  terms: {
    title: "利用規約",
    lead: "PassShare サービス（Web ポータル、Desktop、Mobile、拡張機能、Connect API）の利用条件です。 運営事業者はAutoDevJapanです。お問い合わせ: contact@autodevjapan.com。",
    sections: [
      {
        id: "acceptance",
        title: "1. 規約への同意",
        paragraphs: [
          "本サービスを利用することで、本利用規約に同意したものとみなします。",
          "同意いただけない場合はサービスを利用しないでください。",
        ],
      },
      {
        id: "service",
        title: "2. サービス内容",
        paragraphs: [
          "PassShare はパスワードボックスの暗号化・保存・同期機能を提供します。",
          "端末版の .pbox は端末で暗号化し、マスターパスワードをサーバーへ送りません。現在の Web・クラウド同期・Connect API は項目の内容をサーバーへ送り、サーバーとデータベースで扱います。クラウドはサーバーが秘密値を読めない方式ではありません。",
        ],
      },
      {
        id: "account",
        title: "3. アカウント",
        paragraphs: [
          "利用者は正確な登録情報を提供し、認証情報を適切に管理する責任を負います。",
          "アカウントの不正利用が疑われる場合、当社はアクセス制限を行うことがあります。",
        ],
      },
      {
        id: "prohibited",
        title: "4. 禁止事項",
        list: [
          "法令または公序良俗に反する利用",
          "他者のアカウントへの不正アクセス",
          "サービスの可用性を害する行為（過度な API 呼び出し等）",
          "リバースエンジニアリングによる脆弱性の悪用",
        ],
        paragraphs: [],
      },
      {
        id: "disclaimer",
        title: "5. 免責",
        paragraphs: [
          "本サービスは現状有姿で提供されます。利用者のマスターパスワード紛失によるデータ復旧不能について、当社は責任を負いません。",
          "計画メンテナンスまたは不可抗力による中断について、事前通知なくサービスを停止する場合があります。",
        ],
      },
      {
        id: "changes",
        title: "6. 規約の変更",
        paragraphs: [
          "本規約は必要に応じて改定されます。重要な変更は Web 上で告知します。",
          "改定後もサービスを継続利用した場合、改定後の規約に同意したものとみなします。",
        ],
      },
    ],
    legalReview: [
      { label: "文書バージョン", value: "0.2.0-draft" },
      { label: "最終更新", value: "2026-10-04" },
      { label: "法務レビュー", value: "未実施（草案）" },
      { label: "承認", value: "⏳ 本番公開前に法務確認必須" },
    ],
  },
  privacy: {
    title: "プライバシーポリシー",
    lead: "PassShare が収集・利用する情報と、利用者の権利について説明します。",
    sections: [
      {
        id: "controller",
        title: "1. 管理者",
        paragraphs: ["PassShare（AutoDevJapan）が本サービスにおける個人情報の管理者です。"],
      },
      {
        id: "collect",
        title: "2. 収集する情報",
        list: [
          "アカウント情報（メールアドレス、表示名）",
          "認証・セッション関連メタデータ（HttpOnly Cookie、Connect トークン識別子）",
          "Connect API 経由の項目（タイトル・カテゴリ・ユーザー名・パスワード・メモ等。現在のクラウドはサーバーとデータベースが内容を扱います）",
          "アクセスログ（IP、User-Agent、タイムスタンプ — 秘密値は記録しません）",
        ],
        paragraphs: [],
      },
      {
        id: "purpose",
        title: "3. 利用目的",
        list: [
          "認証・認可およびアカウント管理",
          "パスワードボックスの同期・バックアップ",
          "セキュリティ監査、障害対応、サービス改善",
          "法令に基づく対応",
        ],
        paragraphs: [],
      },
      {
        id: "storage",
        title: "4. 保存場所と期間",
        paragraphs: [
          "データは Railway（PostgreSQL）および Vercel（フロントエンド）上に保存されます。",
          "アカウント削除要求後、合理的な期間内に関連データを削除します（バックアップ保持期間を除く）。",
        ],
      },
      {
        id: "thirdparty",
        title: "5. 第三者提供",
        paragraphs: [
          "法令に基づく場合を除き、本人の同意なく個人情報を第三者に提供しません。",
          "インフラ提供者（Railway, Vercel）はデータ処理の委託先として利用します。",
        ],
      },
      {
        id: "rights",
        title: "6. 利用者の権利",
        paragraphs: [
          "利用者は自己の個人情報について、開示・訂正・削除を請求できます。",
          "お問い合わせ: contact@autodevjapan.com。",
        ],
      },
    ],
    legalReview: [
      { label: "文書バージョン", value: "0.2.0-draft" },
      { label: "最終更新", value: "2026-10-04" },
      { label: "法務レビュー", value: "未実施（草案）" },
      { label: "承認", value: "⏳ 本番公開前に法務確認必須" },
    ],
  },
  faq: {
    title: "よくある質問",
    lead: "PassShare 利用時によくある質問と対処法です。",
    sections: [
      {
        id: "forgot-master",
        title: "マスターパスワードを忘れた",
        paragraphs: [
          "マスターパスワードはPassShareサーバーに保存されません。復旧対応版では、復旧が有効な .pbox ファイルと緊急キットのコードを使い、新しいマスターパスワードを設定できます。旧ファイルは、忘れる前に現在のマスターパスワードで復旧を有効化する必要があります。",
          "ファイルの控えとコードは別々に保管してください。コードだけではファイルを取り戻せません。利用中の版が復旧に対応するかはユーザーガイドで確認してください。復旧が無効なファイルを、コードだけで開くことはできません。",
          "Webの所有者暗号化モードは別の復旧です。所有者としてログインし、現在の鍵世代に対応する控えファイルとコード、新しい暗号化パスワード、現在のログイン用パスワードが必要です。ログイン用パスワードの再設定だけでは暗号化データは復旧できません。全クライアントの復旧と販売前の検査は未完です。",
        ],
      },
      {
        id: "sync-conflict",
        title: "クラウド同期で競合が出る",
        paragraphs: [
          "Desktop 設定 → クラウド同期で競合一覧を確認し、「ローカル優先」または「クラウド優先」を選択してください。",
        ],
      },
      {
        id: "extension-login",
        title: "拡張機能にログインできない",
        list: [
          "OP_CONNECT_HOST が正しい Backend URL を指しているか確認",
          "Web でログイン後、拡張用 refresh トークンが発行されているか確認",
          "拡張を再読み込みしてから再ログイン",
        ],
        paragraphs: [],
      },
      {
        id: "401",
        title: "API が 401 を返す",
        list: [
          "Connect Bearer トークンの有効期限切れ → Web / Mobile / Extension から再ログイン",
          "OP_CONNECT_TOKEN 環境変数（CLI 利用時）が最新か確認",
        ],
        paragraphs: [],
      },
      {
        id: "clipboard",
        title: "コピーしたパスワードが消えない",
        paragraphs: [
          "Desktop / Web の設定でクリップボード自動消去秒数を確認してください（デフォルト 30 秒）。",
          "OS 側のクリップボード履歴機能は PassShare の制御外です。",
        ],
      },
    ],
  },
};
