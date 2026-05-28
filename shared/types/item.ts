export type ItemCategory =
  | "LOGIN"
  | "PASSWORD"
  | "SECURE_NOTE"
  | "CREDIT_CARD"
  | "IDENTITY"
  | "SSH_KEY"
  | "CUSTOM";

export type ConnectItem = {
  id: string;
  title: string;
  category: ItemCategory;
  tags: string[];
  favorite: boolean;
  url?: string | null;
  username?: string | null;
  password?: string | null;
  body?: string | null;
  notes?: string | null;
};

export type ItemFormValues = {
  category: ItemCategory;
  title: string;
  url: string;
  username: string;
  password: string;
  body: string;
  notes: string;
  tags: string;
  favorite: boolean;
};

export type ItemUiLabels = {
  categoryLogin: string;
  categoryPassword: string;
  categorySecureNote: string;
  categoryCreditCard: string;
  categoryIdentity: string;
  categorySshKey: string;
  categoryCustom: string;
  fieldTitle: string;
  fieldUrl: string;
  fieldUsername: string;
  fieldPassword: string;
  fieldBody: string;
  fieldNotes: string;
  fieldTags: string;
  fieldFavorite: string;
  addHeading: string;
  editHeading: string;
  listHeading: string;
  searchPlaceholder: string;
  generatePassword: string;
  submitAdd: string;
  submitSave: string;
  cancelEdit: string;
  copyPassword: string;
  copyBody: string;
  copied: string;
  delete: string;
  edit: string;
  importCsv: string;
  import1pux: string;
  exportCsv: string;
  importSuccess: string;
  import1puxSuccess: string;
  exportSuccess: string;
  emptyList: string;
  lock: string;
  countSuffix: string;
  confirmDelete: string;
  notSet: string;
};

export const ITEM_CATEGORIES: ItemCategory[] = [
  "LOGIN",
  "PASSWORD",
  "SECURE_NOTE",
  "CREDIT_CARD",
  "IDENTITY",
  "SSH_KEY",
  "CUSTOM",
];

export function isBodyCategory(category: ItemCategory): boolean {
  return (
    category === "SECURE_NOTE" ||
    category === "CREDIT_CARD" ||
    category === "IDENTITY" ||
    category === "SSH_KEY" ||
    category === "CUSTOM"
  );
}

export function categoryLabel(category: ItemCategory, labels: ItemUiLabels): string {
  switch (category) {
    case "LOGIN":
      return labels.categoryLogin;
    case "PASSWORD":
      return labels.categoryPassword;
    case "SECURE_NOTE":
      return labels.categorySecureNote;
    case "CREDIT_CARD":
      return labels.categoryCreditCard;
    case "IDENTITY":
      return labels.categoryIdentity;
    case "SSH_KEY":
      return labels.categorySshKey;
    case "CUSTOM":
      return labels.categoryCustom;
  }
}

export function emptyFormValues(category: ItemCategory = "LOGIN"): ItemFormValues {
  return {
    category,
    title: "",
    url: "",
    username: "",
    password: "",
    body: "",
    notes: "",
    tags: "",
    favorite: false,
  };
}

export function formValuesFromItem(item: ConnectItem): ItemFormValues {
  return {
    category: item.category,
    title: item.title,
    url: item.url ?? "",
    username: item.username ?? "",
    password: item.password ?? "",
    body: item.body ?? "",
    notes: item.notes ?? "",
    tags: item.tags.join(", "),
    favorite: item.favorite,
  };
}

export function parseTagsInput(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}
