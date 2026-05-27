import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Root element #app not found");
}

const environment = import.meta.env.VITE_APP_ENV ?? "local";
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

app.innerHTML = `
  <main class="shell">
    <p class="eyebrow">PassShare</p>
    <h1>パスワードボックス</h1>
    <p class="lead">非 IT 向けパスワードマネージャー。デスクトップアプリ（Tauri）と Web ポータルを提供します。</p>
    <dl class="meta">
      <div><dt>環境</dt><dd>${escapeHtml(environment)}</dd></div>
      <div><dt>API</dt><dd>${escapeHtml(apiBaseUrl || "未設定")}</dd></div>
    </dl>
  </main>
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
