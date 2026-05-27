import type { FormEvent } from "react";
import type { ItemCategory, ItemFormValues, ItemUiLabels } from "../types/item.js";
import { CategoryPicker } from "./CategoryPicker.js";

type ItemFormProps = {
  mode: "create" | "edit";
  values: ItemFormValues;
  labels: ItemUiLabels;
  error?: string;
  onChange: (values: ItemFormValues) => void;
  onSubmit: (values: ItemFormValues) => void;
  onCancel?: () => void;
  onGeneratePassword?: () => void;
};

export function ItemForm({
  mode,
  values,
  labels,
  error,
  onChange,
  onSubmit,
  onCancel,
  onGeneratePassword,
}: ItemFormProps) {
  function updateField<K extends keyof ItemFormValues>(field: K, value: ItemFormValues[K]) {
    onChange({ ...values, [field]: value });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(values);
  }

  const showLoginFields = values.category === "LOGIN";
  const showPasswordField = values.category === "LOGIN" || values.category === "PASSWORD";
  const showBodyField = values.category === "SECURE_NOTE";
  const showNotesField = values.category !== "SECURE_NOTE";

  return (
    <form className="ps-card ps-card--form" onSubmit={handleSubmit}>
      <h3 className="ps-heading-3">{mode === "create" ? labels.addHeading : labels.editHeading}</h3>

      <CategoryPicker
        value={values.category}
        labels={labels}
        disabled={mode === "edit"}
        onChange={(category: ItemCategory) => updateField("category", category)}
      />

      <div className="ps-grid">
        <label className="ps-label">
          {labels.fieldTitle}
          <input
            className="ps-input"
            required
            value={values.title}
            onChange={(event) => updateField("title", event.target.value)}
          />
        </label>

        {showLoginFields ? (
          <label className="ps-label">
            {labels.fieldUrl}
            <input
              className="ps-input"
              type="url"
              value={values.url}
              onChange={(event) => updateField("url", event.target.value)}
            />
          </label>
        ) : null}

        {showLoginFields ? (
          <label className="ps-label">
            {labels.fieldUsername}
            <input
              className="ps-input"
              value={values.username}
              onChange={(event) => updateField("username", event.target.value)}
            />
          </label>
        ) : null}

        {showPasswordField ? (
          <label className="ps-label">
            {labels.fieldPassword}
            <span className="ps-inline">
              <input
                className="ps-input"
                required={values.category !== "LOGIN" || mode === "create"}
                value={values.password}
                onChange={(event) => updateField("password", event.target.value)}
              />
              {onGeneratePassword ? (
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  onClick={onGeneratePassword}
                >
                  {labels.generatePassword}
                </button>
              ) : null}
            </span>
          </label>
        ) : null}

        {showBodyField ? (
          <label className="ps-label ps-label--full">
            {labels.fieldBody}
            <textarea
              className="ps-input ps-textarea"
              required
              rows={5}
              value={values.body}
              onChange={(event) => updateField("body", event.target.value)}
            />
          </label>
        ) : null}

        {showNotesField ? (
          <label className="ps-label ps-label--full">
            {labels.fieldNotes}
            <textarea
              className="ps-input ps-textarea"
              rows={3}
              value={values.notes}
              onChange={(event) => updateField("notes", event.target.value)}
            />
          </label>
        ) : null}

        <label className="ps-label">
          {labels.fieldTags}
          <input
            className="ps-input"
            placeholder="work, personal"
            value={values.tags}
            onChange={(event) => updateField("tags", event.target.value)}
          />
        </label>

        <label className="ps-label ps-label--checkbox">
          <input
            type="checkbox"
            checked={values.favorite}
            onChange={(event) => updateField("favorite", event.target.checked)}
          />
          {labels.fieldFavorite}
        </label>
      </div>

      <div className="ps-actions">
        <button type="submit" className="ps-button ps-button--primary">
          {mode === "create" ? labels.submitAdd : labels.submitSave}
        </button>
        {mode === "edit" && onCancel ? (
          <button type="button" className="ps-button ps-button--secondary" onClick={onCancel}>
            {labels.cancelEdit}
          </button>
        ) : null}
      </div>

      {error ? <p className="ps-status ps-status--error">{error}</p> : null}
    </form>
  );
}
