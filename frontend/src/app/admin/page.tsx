"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectWallet } from "@/components/redoubt/connect-wallet";
import { NetworkGate } from "@/components/redoubt/network-gate";
import { CaseFileFrame } from "@/components/redoubt/case-file-frame";
import { OwnerGate } from "@/components/redoubt/admin/owner-gate";
import { OraclePriceCard } from "@/components/redoubt/admin/oracle-price-card";
import { EpochSettlementCard } from "@/components/redoubt/admin/epoch-settlement-card";
import { SolvencyCheckCard } from "@/components/redoubt/admin/solvency-check-card";
import { ClaimWindowCard } from "@/components/redoubt/admin/claim-window-card";
import { AbandonClaimCard } from "@/components/redoubt/admin/abandon-claim-card";
import { REDOUBT_CHAIN } from "@/lib/contracts";

// Session 23: pool-lifecycle actions that aren't aimed at an ordinary
// policyholder. Linked from /app's header (a small "Admin" link) since
// OwnerGate already makes visiting harmless for anyone who isn't the
// oracle owner -- not linked from the marketing page.
//
// Gated on MockPriceOracle.owner() (see owner-gate.tsx), NOT a pool-level
// role -- RedoubtCoverPool.sol has no owner/access-control concept
// whatsoever. Every pool action below is genuinely permissionless and
// callable by any address directly against the contract; this page groups
// them here for operational convenience, not because the contract
// restricts them to this wallet.
export default function AdminHome() {
  const { address } = useAccount();

  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="border-b border-line/70 px-6 py-4 sm:px-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <Link
              href="/"
              className="font-heading text-lg font-semibold tracking-tight hover:text-primary"
            >
              Redoubt
            </Link>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Admin · {REDOUBT_CHAIN.name}
            </p>
          </div>
          <ConnectWallet />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10 sm:px-10">
        <NetworkGate />

        <CaseFileFrame>
          <p className="font-mono text-[11px] text-muted-foreground/70">
            Gated to the wallet that owns <code>MockPriceOracle</code> — not a privileged role
            on <code>RedoubtCoverPool</code> itself, which has no owner or access control at
            all. Every pool action on this page is permissionless on-chain and callable by
            anyone directly; this page exists purely to group rare, operationally risky actions
            away from the ordinary policyholder flow at <Link href="/app" className="text-primary underline underline-offset-4">/app</Link>.
          </p>
        </CaseFileFrame>

        {!address ? (
          <CaseFileFrame>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Connect a wallet to continue.
            </p>
          </CaseFileFrame>
        ) : (
          <OwnerGate>
            {/* Two columns on wider screens so the five cards don't turn
                this page into one long vertical scroll -- single column on
                mobile. AbandonClaimCard spans both since it's a distinct
                lookup tool (address input + event scan), not a peer-sized
                status card. */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:items-start">
              <OraclePriceCard />
              <ClaimWindowCard />
              <EpochSettlementCard />
              <SolvencyCheckCard />
              <div className="md:col-span-2">
                <AbandonClaimCard />
              </div>
            </div>
          </OwnerGate>
        )}
      </main>
    </div>
  );
}
