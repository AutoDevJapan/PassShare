export type ItemCategory = "LOGIN" | "PASSWORD" | "SECURE_NOTE";

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
  copied: string;
  delete: string;
  edit: string;
  importCsv: string;
  importSuccess: string;
  emptyList: string;
  lock: string;
  countSuffix: string;
  confirmDelete: string;
  notSet: string;
};

export const ITEM_CATEGORIES: ItemCategory[] = ["LOGIN", "PASSWORD", "SECURE_NOTE"];

export function categoryLabel(category: ItemCategory, labels: ItemUiLabels): string {
  switch (category) {
    case "LOGIN":
      return labels.categoryLogin;
    case "PASSWORD":
      return labels.categoryPassword;
    case "SECURE_NOTE":
      return labels.categorySecureNote;
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
