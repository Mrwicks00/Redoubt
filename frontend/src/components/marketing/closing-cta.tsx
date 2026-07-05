import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONTRACTS, REDOUBT_CHAIN } from "@/lib/contracts";
import { RevealSection } from "./reveal-section";

const explorerBase = REDOUBT_CHAIN.blockExplorers?.default.url;

const VERIFIED = [
  { label: "RedoubtCoverPool", address: CONTRACTS.redoubtCoverPool },
  { label: "MockPriceOracle", address: CONTRACTS.mockPriceOracle },
  { label: "cUSDCMock (premium token)", address: CONTRACTS.premiumToken },
] as const;

export function ClosingCta() {
  return (
    <RevealSection className="px-6 py-20 sm:px-10 sm:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="font-heading text-3xl font-semibold sm:text-4xl">
          Read the case file yourself.
        </h2>
        <p className="mt-4 text-muted-foreground">
          Every contract below is deployed and verified on {REDOUBT_CHAIN.name}
          . The pool status screen reads it live — no wallet required to
          look, one required to act.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button render={<Link href="/app" />} nativeButton={false} size="lg">
            Open pool status
          </Button>
        </div>

        <div className="mx-auto mt-12 max-w-xl divide-y divide-line/60 rounded-lg border border-line/70 bg-card/40 text-left">
          {VERIFIED.map((c) => (
            <a
              key={c.address}
              href={`${explorerBase}/address/${c.address}`}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/40"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {c.label}
              </span>
              <span className="flex items-center gap-1 font-mono text-xs text-foreground">
                {c.address.slice(0, 8)}…{c.address.slice(-4)}
                <ArrowUpRight className="size-3 text-muted-foreground transition-colors group-hover:text-primary" />
              </span>
            </a>
          ))}
        </div>

        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Redoubt · confidential cover pools on Zama FHEVM
        </p>
      </div>
    </RevealSection>
  );
}
