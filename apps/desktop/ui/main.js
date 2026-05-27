const { invoke } = window.__TAURI__.core;

const setupPanel = document.getElementById("setup-panel");
const mainPanel = document.getElementById("main-panel");
const boxPathInput = document.getElementById("box-path");
const masterPasswordInput = document.getElementById("master-password");
const setupMessage = document.getElementById("setup-message");
const itemList = document.getElementById("item-list");
const searchInput = document.getElementById("search");

function showMessage(text, isError = false) {
  setupMessage.textContent = text;
  setupMessage.classList.toggle("ps-message--error", isError);
}

function showMain() {
  setupPanel.classList.add("ps-hidden");
  mainPanel.classList.remove("ps-hidden");
}

function showSetup() {
  mainPanel.classList.add("ps-hidden");
  setupPanel.classList.remove("ps-hidden");
  masterPasswordInput.value = "";
}

async function refreshItems(query = "") {
  const items = query
    ? await invoke("search_items", { query })
    : await invoke("list_items");
  itemList.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.url || "URL 未設定")} / ${escapeHtml(item.username || "ユーザー名未設定")}</p>
      <div class="ps-item-actions">
        <button type="button" class="ps-button ps-button--secondary" data-copy="${escapeAttr(item.password)}">パスワードをコピー</button>
        <button type="button" class="ps-button ps-button--secondary" data-delete="${escapeAttr(item.id)}">削除</button>
      </div>
    `;
    itemList.appendChild(li);
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

document.getElementById("btn-create").addEventListener("click", async () => {
  try {
    const recovery = await invoke("create_password_box", {
      path: boxPathInput.value.trim(),
      masterPassword: masterPasswordInput.value,
    });
    showMessage(
      recovery
        ? `パスワードボックスを作成しました。緊急キット: ${recovery}（必ず控えてください）`
        : "パスワードボックスを作成しました。"
    );
    showMain();
    await refreshItems();
  } catch (err) {
    showMessage(String(err), true);
  }
});

document.getElementById("btn-open").addEventListener("click", async () => {
  try {
    await invoke("open_password_box", {
      path: boxPathInput.value.trim(),
      masterPassword: masterPasswordInput.value,
    });
    showMessage("パスワードボックスを開きました。");
    showMain();
    await refreshItems();
  } catch (err) {
    showMessage(String(err), true);
  }
});

document.getElementById("btn-lock").addEventListener("click", async () => {
  await invoke("lock_password_box");
  showSetup();
});

document.getElementById("btn-generate").addEventListener("click", async () => {
  const password = await invoke("generate_password", { length: 16 });
  document.getElementById("add-password").value = password;
});

document.getElementById("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke("add_item", {
      title: document.getElementById("add-title").value.trim(),
      password: document.getElementById("add-password").value,
      url: document.getElementById("add-url").value.trim() || null,
      username: document.getElementById("add-username").value.trim() || null,
      notes: null,
      masterPassword: masterPasswordInput.value,
    });
    document.getElementById("add-form").reset();
    await refreshItems(searchInput.value.trim());
  } catch (err) {
    alert(String(err));
  }
});

searchInput.addEventListener("input", async () => {
  await refreshItems(searchInput.value.trim());
});

itemList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.dataset.copy) {
    await navigator.clipboard.writeText(target.dataset.copy);
    target.textContent = "コピーしました";
    setTimeout(() => {
      target.textContent = "パスワードをコピー";
    }, 2000);
    return;
  }

  if (target.dataset.delete) {
    if (!confirm("このログイン情報を削除しますか？")) return;
    try {
      await invoke("delete_item", {
        id: target.dataset.delete,
        masterPassword: masterPasswordInput.value,
      });
      await refreshItems(searchInput.value.trim());
    } catch (err) {
      alert(String(err));
    }
  }
});
