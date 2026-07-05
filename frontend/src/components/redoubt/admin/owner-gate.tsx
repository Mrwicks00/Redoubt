"use client";

import { useAccount, useReadContract } from "wagmi";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ABIS, CONTRACTS } from "@/lib/contracts";
import { CaseFileFrame } from "../case-file-frame";

// Session 23: the ONLY real access-control check on this whole route.
// RedoubtCoverPool.sol itself has no owner/access-control concept at all --
// every pool function this page exposes (settleEpoch, checkSolvency,
// triggerClaimWindow, settleClaimWindow, abandonStuck*) is genuinely
// permissionless on-chain, callable by any address directly against the
// contract regardless of what this page does. MockPriceOracle.sol is the
// one piece with real on-chain gating (`owner`, checked in `setPrice`), so
// gating this entire admin route on that same owner is precise, not an
// invented privilege: this page is "the wallet that controls the mock
// oracle," not "the pool's admin." Unauthorized visitors get zero access to
// any child content -- not disabled buttons, no rendered forms at all --
// since the gate wraps children rather than passing an `isOwner` flag down.
export function OwnerGate({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();

  const { data: ownerData, isLoading, isError, error } = useReadContract({
    address: CONTRACTS.mockPriceOracle,
    abi: ABIS.mockPriceOracle,
    functionName: "owner",
  });
  const owner = ownerData as `0x${string}` | undefined;

  if (isLoading) {
    return (
      <CaseFileFrame>
        <Skeleton className="h-24 w-full" />
      </CaseFileFrame>
    );
  }

  if (isError) {
    return (
      <CaseFileFrame>
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
          <ShieldAlert data-icon="inline-start" />
          <AlertTitle className="font-mono">OWNER LOOKUP FAILED</AlertTitle>
          <AlertDescription>
            {error?.message ?? "Could not read MockPriceOracle.owner()."}
          </AlertDescription>
        </Alert>
      </CaseFileFrame>
    );
  }

  const isOwner =
    Boolean(address) &&
    typeof owner === "string" &&
    owner.toLowerCase() === address?.toLowerCase();

  if (!isOwner) {
    return (
      <CaseFileFrame>
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
          <ShieldAlert data-icon="inline-start" />
          <AlertTitle className="font-mono tracking-wide">NOT AUTHORIZED</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              This route is gated to the wallet that deployed{" "}
              <code>MockPriceOracle</code> ({owner ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : "unknown"}
              ). Your connected wallet doesn&apos;t match.
            </p>
            <p className="font-mono text-[11px] text-muted-foreground/80">
              Note: this is a frontend-only convenience gate, not a real security
              boundary. <code>RedoubtCoverPool</code> itself has no owner or
              access-control concept — every pool action below is genuinely
              permissionless and callable by any address directly against the
              contract. Only <code>MockPriceOracle.setPrice</code> is actually
              enforced on-chain.
            </p>
          </AlertDescription>
        </Alert>
      </CaseFileFrame>
    );
  }

  return <>{children}</>;
}
