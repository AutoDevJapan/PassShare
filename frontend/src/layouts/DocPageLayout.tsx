import type { ReactNode } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";

type DocPageLayoutProps = {
  children: ReactNode;
};

export function DocPageLayout({ children }: DocPageLayoutProps) {
  return (
    <div className="landing">
      <Header />
      <main className="doc-page">{children}</main>
      <Footer />
    </div>
  );
}
