export type DocSection = {
  id: string;
  title: string;
  paragraphs: string[];
  list?: string[];
};

export type LegalReviewRow = {
  label: string;
  value: string;
};

export type DocPageContent = {
  title: string;
  lead?: string;
  sections: DocSection[];
  legalReview?: LegalReviewRow[];
};

export type DocsHubLink = {
  path: string;
  title: string;
  description: string;
};

export type DocsHubContent = {
  title: string;
  lead: string;
  links: DocsHubLink[];
};

export type LocaleDocs = {
  hub: DocsHubContent;
  userGuide: DocPageContent;
  extensionInstall: DocPageContent;
  terms: DocPageContent;
  privacy: DocPageContent;
  faq: DocPageContent;
};
