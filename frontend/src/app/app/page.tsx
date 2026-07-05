import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConnectWallet } from "@/components/redoubt/connect-wallet";
import { NetworkGate } from "@/components/redoubt/network-gate";
import { PoolStatusCard } from "@/components/redoubt/pool-status-card";
import { GetFundsCard } from "@/components/redoubt/get-funds-card";
import { BuyCoverCard } from "@/components/redoubt/buy-cover-card";
import { MyCoverageCard } from "@/components/redoubt/my-coverage-card";
import { ClaimCard } from "@/components/redoubt/claim-card";
import { REDOUBT_CHAIN } from "@/lib/contracts";

export default function AppHome() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="border-b border-line/70 px-6 py-4 sm:px-10">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <Link
              href="/"
              className="font-heading text-lg font-semibold tracking-tight hover:text-primary"
            >
              Redoubt
            </Link>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Confidential cover pool · {REDOUBT_CHAIN.name}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button render={<Link href="/admin" />} nativeButton={false} size="sm" variant="outline">
              Admin
            </Button>
            <ConnectWallet />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10 sm:px-10">
        <NetworkGate />
        <PoolStatusCard />
        <GetFundsCard />
        <BuyCoverCard />
        <div id="my-coverage">
          <MyCoverageCard />
        </div>
        <ClaimCard />
      </main>
    </div>
  );
}
