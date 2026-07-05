import { MarketingHeader } from "@/components/marketing/marketing-header";
import { HeroSection } from "@/components/marketing/hero-section";
import { WhyFheSection } from "@/components/marketing/why-fhe-section";
import { MechanismSection } from "@/components/marketing/mechanism-section";
import { LeakageTableSection } from "@/components/marketing/leakage-table";
import { AlternativesStrip } from "@/components/marketing/alternatives-strip";
import { ClosingCta } from "@/components/marketing/closing-cta";

export default function MarketingHome() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <MarketingHeader />
      <main className="flex flex-1 flex-col">
        <HeroSection />
        <WhyFheSection />
        <MechanismSection />
        <LeakageTableSection />
        <AlternativesStrip />
        <ClosingCta />
      </main>
    </div>
  );
}
