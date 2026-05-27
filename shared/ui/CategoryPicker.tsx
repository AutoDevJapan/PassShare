import type { ItemCategory, ItemUiLabels } from "../types/item.js";
import { categoryLabel } from "../types/item.js";

type CategoryPickerProps = {
  value: ItemCategory;
  labels: ItemUiLabels;
  onChange: (category: ItemCategory) => void;
  disabled?: boolean;
};

const CATEGORIES: ItemCategory[] = ["LOGIN", "PASSWORD", "SECURE_NOTE"];

export function CategoryPicker({ value, labels, onChange, disabled = false }: CategoryPickerProps) {
  return (
    <div className="ps-category-picker" role="tablist" aria-label="カテゴリ">
      {CATEGORIES.map((category) => (
        <button
          key={category}
          type="button"
          role="tab"
          aria-selected={value === category}
          className={`ps-chip ${value === category ? "ps-chip--active" : ""}`}
          disabled={disabled}
          onClick={() => onChange(category)}
        >
          {categoryLabel(category, labels)}
        </button>
      ))}
    </div>
  );
}
