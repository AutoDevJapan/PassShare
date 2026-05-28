import { useMobileLabels } from "../hooks/useMobileLabels";

type Tab = "vaults" | "settings";

type Props = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

export function BottomNav({ active, onChange }: Props) {
  const labels = useMobileLabels();

  return (
    <nav className="mobile-bottom-nav" aria-label={labels.vaultTab}>
      <button
        type="button"
        className={active === "vaults" ? "mobile-bottom-nav__item is-active" : "mobile-bottom-nav__item"}
        onClick={() => onChange("vaults")}
      >
        {labels.vaultTab}
      </button>
      <button
        type="button"
        className={active === "settings" ? "mobile-bottom-nav__item is-active" : "mobile-bottom-nav__item"}
        onClick={() => onChange("settings")}
      >
        {labels.settingsTab}
      </button>
    </nav>
  );
}
