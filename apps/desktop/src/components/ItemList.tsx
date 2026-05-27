import { useState } from "react";
import type { LoginItem } from "../types";

type ItemListProps = {
  items: LoginItem[];
  onDelete: (id: string) => void;
};

function ItemRow({ item, onDelete }: { item: LoginItem; onDelete: (id: string) => void }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(item.password);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li className="ps-item-card">
      <div className="ps-item-card__body">
        <h4 className="ps-item-card__title">{item.title}</h4>
        <dl className="ps-meta ps-meta--compact">
          <div>
            <dt>URL</dt>
            <dd>{item.url || "未設定"}</dd>
          </div>
          <div>
            <dt>ユーザー名</dt>
            <dd>{item.username || "未設定"}</dd>
          </div>
        </dl>
      </div>
      <div className="ps-item-actions">
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleCopy()}>
          {copied ? "コピーしました" : "パスワードをコピー"}
        </button>
        <button type="button" className="ps-button ps-button--secondary" onClick={() => onDelete(item.id)}>
          削除
        </button>
      </div>
    </li>
  );
}

export function ItemList({ items, onDelete }: ItemListProps) {
  if (items.length === 0) {
    return <p className="ps-text-muted">ログイン情報がありません。上のフォームから追加してください。</p>;
  }

  return (
    <ul className="ps-item-list">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} onDelete={onDelete} />
      ))}
    </ul>
  );
}
