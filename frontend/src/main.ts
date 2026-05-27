import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Root element #app not found");
}

const environment = import.meta.env.VITE_APP_ENV ?? "local";
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

app.innerHTML = `
  <main class="ps-shell ps-shell--wide">
    <p class="ps-eyebrow">PassShare</p>
    <span class="ps-badge">完全無料</span>
    <h1 class="ps-heading-1">パスワードボックス</h1>
    <p class="ps-lead">非 IT 向けパスワードマネージャー。デスクトップアプリ（Tauri）と Web ポータルを提供します。</p>

    <div class="ps-actions">
      <button type="button" class="ps-button ps-button--primary">パスワードボックスを開く</button>
      <button type="button" class="ps-button ps-button--secondary">詳細を見る</button>
    </div>

    <section class="ps-showcase" aria-label="デザインシステムサンプル">
      <div class="ps-showcase__section">
        <p class="ps-showcase__label">Quick Start</p>
        <pre class="ps-code-block"><code># パスワードボックスを新規作成
passshare create --path ~/Documents/mybox.pbox

# マスターパスワードで開く
passshare open --path ~/Documents/mybox.pbox</code></pre>
      </div>

      <div class="ps-showcase__section">
        <p class="ps-showcase__label">環境</p>
        <dl class="ps-meta">
          <div><dt>環境</dt><dd>${escapeHtml(environment)}</dd></div>
          <div><dt>API</dt><dd>${escapeHtml(apiBaseUrl || "未設定")}</dd></div>
        </dl>
      </div>
    </section>
  </main>
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
