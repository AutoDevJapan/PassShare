import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";

export function App() {
  return (
    <div className="landing">
      <Header />
      <main>
        <Hero />
      </main>
      <Footer />
    </div>
  );
}
