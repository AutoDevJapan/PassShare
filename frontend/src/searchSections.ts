import type { MessageKey } from "@shared/i18n/index";

export type SearchSection = {
  id: string;
  href: string;
  labelKey: MessageKey;
};

export const SEARCH_SECTIONS: SearchSection[] = [
  { id: "home", href: "#", labelKey: "search.sections.home" },
  { id: "download", href: "#download", labelKey: "search.sections.download" },
  { id: "quick-start", href: "#quick-start", labelKey: "search.sections.quickStart" },
  { id: "features", href: "#features", labelKey: "search.sections.features" },
  { id: "migration", href: "#migration", labelKey: "search.sections.migration" },
  { id: "comparison", href: "#comparison", labelKey: "search.sections.comparison" },
  { id: "get-started", href: "#get-started", labelKey: "search.sections.getStarted" },
  { id: "docs", href: "/docs", labelKey: "search.sections.docs" },
];
