import { ComparisonSection } from "../components/ComparisonSection";
import { FeaturesSection } from "../components/FeaturesSection";
import { Footer } from "../components/Footer";
import { GetStartedSection } from "../components/GetStartedSection";
import { Header } from "../components/Header";
import { Hero } from "../components/Hero";
import { MigrationSection } from "../components/MigrationSection";
import { QuickStartSection } from "../components/QuickStartSection";

export function LandingPage() {
  return (
    <div className="landing">
      <Header />
      <main>
        <Hero />
        <QuickStartSection />
        <FeaturesSection />
        <MigrationSection />
        <ComparisonSection />
        <GetStartedSection />
      </main>
      <Footer />
    </div>
  );
}
