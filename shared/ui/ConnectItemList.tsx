import { useState } from "react";
import type { ConnectItem, ItemUiLabels } from "../types/item.js";
import { categoryLabel } from "../types/item.js";

type ConnectItemListProps = {
  items: ConnectItem[];
  labels: ItemUiLabels;
  onEdit: (item: ConnectItem) => void;
  onDelete: (id: string) => void;
};

function ItemRow({
  item,
  labels,
  onEdit,
  onDelete,
}: {
  item: ConnectItem;
  labels: ItemUiLabels;
  onEdit: (item: ConnectItem) => void;
  onDelete: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const secret = item.password ?? item.body ?? "";
    if (!secret) {
      return;
    }
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const copyLabel =
    item.category === "SECURE_NOTE"
      ? item.body
        ? "本文をコピー"
        : null
      : item.password
        ? labels.copyPassword
        : null;

  return (
    <li className="ps-item-card">
      <div className="ps-item-card__body">
        <div className="ps-item-card__header">
          <h4 className="ps-item-card__title">
            {item.favorite ? <span className="ps-favorite" aria-label="お気に入り">★</span> : null}
            {item.title}
          </h4>
          <span className="ps-chip ps-chip--category">{categoryLabel(item.category, labels)}</span>
        </div>

        {item.tags.length > 0 ? (
          <ul className="ps-tag-list">
            {item.tags.map((tag) => (
              <li key={tag} className="ps-tag">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        <dl className="ps-meta ps-meta--compact">
          {item.category === "LOGIN" ? (
            <>
              <div>
                <dt>{labels.fieldUrl}</dt>
                <dd>{item.url || labels.notSet}</dd>
              </div>
              <div>
                <dt>{labels.fieldUsername}</dt>
                <dd>{item.username || labels.notSet}</dd>
              </div>
            </>
          ) : null}
          {item.category === "SECURE_NOTE" && item.body ? (
            <div>
              <dt>{labels.fieldBody}</dt>
              <dd>{item.body.length > 80 ? `${item.body.slice(0, 80)}…` : item.body}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="ps-item-actions">
        {copyLabel ? (
          <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleCopy()}>
            {copied ? labels.copied : copyLabel}
          </button>
        ) : null}
        <button type="button" className="ps-button ps-button--secondary" onClick={() => onEdit(item)}>
          {labels.edit}
        </button>
        <button type="button" className="ps-button ps-button--secondary" onClick={() => onDelete(item.id)}>
          {labels.delete}
        </button>
      </div>
    </li>
  );
}

export function ConnectItemList({ items, labels, onEdit, onDelete }: ConnectItemListProps) {
  if (items.length === 0) {
    return <p className="ps-text-muted">{labels.emptyList}</p>;
  }

  return (
    <ul className="ps-item-list">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} labels={labels} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </ul>
  );
}
