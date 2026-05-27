export type Vault = {
  id: string;
  name: string;
  description?: string;
  type: string;
  items: number;
  createdAt: string;
  updatedAt: string;
  contentVersion?: number;
  attributeVersion?: number;
};

export type ItemOverview = {
  id: string;
  title: string;
  version: number;
  vault: { id: string };
  category: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
};

export type Item = ItemOverview & {
  fields?: Array<{
    id?: string;
    label: string;
    type: string;
    purpose?: string;
    value: string;
  }>;
  urls?: Array<{ href: string; primary?: boolean; label?: string }>;
};

export type ConnectClientOptions = {
  host: string;
  token: string;
};

export type JsonPatchOperation = {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
};
