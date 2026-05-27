import { useEffect, useState } from "react";
import type { LoginItem } from "../types";
import { addItem, deleteItem, generatePassword, listItems, lockPasswordBox, searchItems } from "../tauri";
import { ItemList } from "./ItemList";

type MainPanelProps = {
  masterPassword: string;
  onLocked: () => void;
};

type AddFormState = {
  title: string;
  url: string;
  username: string;
  password: string;
};

const EMPTY_FORM: AddFormState = {
  title: "",
  url: "",
  username: "",
  password: "",
};

export function MainPanel({ masterPassword, onLocked }: MainPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<LoginItem[]>([]);
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);

  async function refreshItems(query = searchQuery.trim()) {
    const nextItems = query ? await searchItems(query) : await listItems();
    setItems(nextItems);
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const nextItems = await listItems();
        if (!cancelled) {
          setItems(nextItems);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSearchChange(value: string) {
    setSearchQuery(value);
    await refreshItems(value.trim());
  }

  async function handleLock() {
    await lockPasswordBox();
    onLocked();
  }

  async function handleGenerate() {
    const password = await generatePassword(16);
    setForm((current) => ({ ...current, password }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await addItem({
        title: form.title.trim(),
        password: form.password,
        url: form.url.trim() || null,
        username: form.username.trim() || null,
        notes: null,
        masterPassword,
      });
      setForm(EMPTY_FORM);
      await refreshItems();
    } catch (err) {
      window.alert(String(err));
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("このログイン情報を削除しますか？")) {
      return;
    }

    try {
      await deleteItem(id, masterPassword);
      await refreshItems();
    } catch (err) {
      window.alert(String(err));
    }
  }

  function updateFormField(field: keyof AddFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <section className="ps-panel ps-panel-spaced" aria-labelledby="main-heading">
      <h2 className="visually-hidden" id="main-heading">
        ログイン情報
      </h2>

      <div className="ps-toolbar">
        <input
          className="ps-input"
          type="search"
          placeholder="サイト名・URL・ユーザー名で検索"
          value={searchQuery}
          onChange={(event) => void handleSearchChange(event.target.value)}
        />
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleLock()}>
          閉じる
        </button>
      </div>

      <form className="ps-form-divider" onSubmit={(event) => void handleSubmit(event)}>
        <h3 className="ps-heading-3">ログイン情報を追加</h3>
        <div className="ps-grid">
          <label className="ps-label">
            サイト名
            <input
              className="ps-input"
              required
              value={form.title}
              onChange={(event) => updateFormField("title", event.target.value)}
            />
          </label>
          <label className="ps-label">
            URL
            <input
              className="ps-input"
              type="url"
              value={form.url}
              onChange={(event) => updateFormField("url", event.target.value)}
            />
          </label>
          <label className="ps-label">
            ユーザー名
            <input
              className="ps-input"
              value={form.username}
              onChange={(event) => updateFormField("username", event.target.value)}
            />
          </label>
          <label className="ps-label">
            パスワード
            <span className="ps-inline">
              <input
                className="ps-input"
                required
                value={form.password}
                onChange={(event) => updateFormField("password", event.target.value)}
              />
              <button
                type="button"
                className="ps-button ps-button--secondary"
                onClick={() => void handleGenerate()}
              >
                生成
              </button>
            </span>
          </label>
        </div>
        <button type="submit" className="ps-button ps-button--primary">
          追加する
        </button>
      </form>

      {loading ? (
        <p className="ps-text-muted">読み込み中…</p>
      ) : (
        <ItemList items={items} onDelete={(id) => void handleDelete(id)} />
      )}
    </section>
  );
}
