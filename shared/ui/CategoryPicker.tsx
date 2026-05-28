import type { ItemCategory, ItemUiLabels } from "../types/item.js";
import { categoryLabel, ITEM_CATEGORIES } from "../types/item.js";

type CategoryPickerProps = {
  value: ItemCategory;
  labels: ItemUiLabels;
  onChange: (category: ItemCategory) => void;
  disabled?: boolean;
  ariaLabel?: string;
};

export function CategoryPicker({
  value,
  labels,
  onChange,
  disabled = false,
  ariaLabel = "Category",
}: CategoryPickerProps) {
  return (
    <div className="ps-category-picker" role="tablist" aria-label={ariaLabel}>
      {ITEM_CATEGORIES.map((category) => (
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
