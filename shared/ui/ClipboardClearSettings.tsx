import { useState } from "react";
import {
  DEFAULT_CLIPBOARD_CLEAR_SECONDS,
  MAX_CLIPBOARD_CLEAR_SECONDS,
  MIN_CLIPBOARD_CLEAR_SECONDS,
  getClipboardClearSeconds,
  setClipboardClearSeconds,
} from "./clipboard-auto-clear.js";

export type ClipboardClearSettingsLabels = {
  heading: string;
  description: string;
  secondsLabel: string;
  secondsSuffix: string;
  save: string;
  saved: string;
};

type ClipboardClearSettingsProps = {
  labels: ClipboardClearSettingsLabels;
};

export function ClipboardClearSettings({ labels }: ClipboardClearSettingsProps) {
  const [seconds, setSeconds] = useState(() => getClipboardClearSeconds());
  const [saved, setSaved] = useState(false);

  function handleSave() {
    const next = setClipboardClearSeconds(seconds);
    setSeconds(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section className="ps-card ps-card--compact" aria-labelledby="clipboard-clear-heading">
      <h3 className="ps-heading-3" id="clipboard-clear-heading">
        {labels.heading}
      </h3>
      <p className="ps-text-muted">{labels.description}</p>
      <label className="ps-label">
        {labels.secondsLabel}
        <div className="ps-inline-field">
          <input
            className="ps-input ps-input--narrow"
            type="number"
            min={MIN_CLIPBOARD_CLEAR_SECONDS}
            max={MAX_CLIPBOARD_CLEAR_SECONDS}
            value={seconds}
            onChange={(event) => setSeconds(Number.parseInt(event.target.value, 10) || DEFAULT_CLIPBOARD_CLEAR_SECONDS)}
          />
          <span className="ps-text-muted">{labels.secondsSuffix}</span>
        </div>
      </label>
      <div className="ps-actions">
        <button type="button" className="ps-button ps-button--secondary" onClick={handleSave}>
          {saved ? labels.saved : labels.save}
        </button>
      </div>
    </section>
  );
}
