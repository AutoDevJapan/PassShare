export type LoginItem = {
  id: string;
  title: string;
  url: string | null;
  username: string | null;
  password: string;
  notes: string | null;
};

export type AppView = "setup" | "main";
