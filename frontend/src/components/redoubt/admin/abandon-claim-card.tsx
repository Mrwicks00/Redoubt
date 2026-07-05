"use client";

import { useEffect, useState } from "react";
import { useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { isAddress, zeroHash } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Ban, ShieldOff, TriangleAlert } from "lucide-react";
import { ABIS, CONTRACTS, REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK } from "@/lib/contracts";
import { CaseFileFrame } from "../case-file-frame";
import { DataRow } from "../data-row";
import { TxConfirmationLink } from "../tx-confirmation-link";
import { useNowSeconds } from "./use-now-seconds";
import { formatDeadline } from "./format-time";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

// Standalone lookup tool, not tied to "my policy" the way claim-card.tsx is
// — an operator needs to unstick an ARBITRARY holder's claim, so this needs
// its own address input rather than living inside another card.
export function AbandonClaimCard() {
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [holderInput, setHolderInput] = useState("");
  const [confirmStep, setConfirmStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [txHash, setTxHash] = useState<`0x${string}`>();

  const holder = isAddress(holderInput) ? (holderInput as `0x${string}`) : undefined;

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "policies", args: [holder ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "claimDecryptionPending", args: [holder ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "claimPendingSince", args: [holder ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "decryptionTimeout" },
    ],
    query: { enabled: Boolean(holder), refetchInterval: 15_000 },
  });

  const [policyR, pendingR, pendingSinceR, timeoutR] = reads ?? [];
  const policy = policyR?.result as readonly [`0x${string}`, bigint, boolean] | undefined;
  const pending = (pendingR?.result as boolean | undefined) ?? false;
  const pendingSince = pendingSinceR?.result as bigint | undefined;
  const decryptionTimeout = timeoutR?.result as bigint | undefined;

  const hasPolicy = policy !== undefined && policy[0] !== zeroHash;
  const claimed = policy?.[2] ?? false;

  const nowSec = useNowSeconds();
  const eligibleAt =
    pendingSince !== undefined && decryptionTimeout !== undefined && pendingSince > BigInt(0)
      ? pendingSince + decryptionTimeout
      : undefined;
  const abandonEligible =
    pending && nowSec !== undefined && eligibleAt !== undefined && nowSec >= eligibleAt;

  // Same ClaimPaid/ClaimDecryptionAbandoned disambiguation claim-card.tsx
  // uses for "my policy" -- reused here for an arbitrary holder, since
  // `claimed` alone can't tell a paid outcome from a foreclosed one apart.
  const [claimPaidCount, setClaimPaidCount] = useState<number>();
  const [abandonedCount, setAbandonedCount] = useState<number>();

  useEffect(() => {
    if (!holder || !publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const [paid, abandoned] = await Promise.all([
          publicClient.getContractEvents({
            ...poolContract,
            eventName: "ClaimPaid",
            args: { holder },
            fromBlock: REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            ...poolContract,
            eventName: "ClaimDecryptionAbandoned",
            args: { holder },
            fromBlock: REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
        ]);
        if (!cancelled) {
          setClaimPaidCount(paid.length);
          setAbandonedCount(abandoned.length);
        }
      } catch {
        if (!cancelled) {
          setClaimPaidCount(undefined);
          setAbandonedCount(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [holder, publicClient, txHash]);

  const outcomeKnown = claimPaidCount !== undefined && abandonedCount !== undefined;
  const wasPaid = outcomeKnown && (claimPaidCount ?? 0) > 0;
  const wasForeclosed = outcomeKnown && (abandonedCount ?? 0) > 0 && !wasPaid;

  async function handleAbandon() {
    if (!holder) return;
    setErrorMessage(undefined);
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        ...poolContract,
        functionName: "abandonStuckClaim",
        args: [holder],
      });
      await waitForTransactionReceipt(config, { hash });
      setTxHash(hash);
      setConfirmStep(false);
      await refetch();
    } catch (e) {
      setErrorMessage(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Permissionless · callable by anyone, for any holder
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">
            Abandon Stuck Claim
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-[11px] text-muted-foreground/70">
            Look up any holder&apos;s pending claim decryption. Unlike the settlement/solvency
            abandon actions, this does NOT allow a retry afterward — claim()&apos;s
            confidentialTransfer already ran synchronously, so re-opening it risks a double
            payment (session 16).
          </p>

          <div className="space-y-2">
            <label className="block font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Holder address
            </label>
            <input
              type="text"
              placeholder="0x…"
              value={holderInput}
              onChange={(e) => {
                setHolderInput(e.target.value);
                setConfirmStep(false);
                setClaimPaidCount(undefined);
                setAbandonedCount(undefined);
              }}
              className="w-full rounded-md border border-line/70 bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            {holderInput && !holder && (
              <p className="font-mono text-[11px] text-destructive">Not a valid address.</p>
            )}
          </div>

          {holder && (
            <>
              <div>
                <DataRow label="Has policy?" value={hasPolicy ? "Yes" : "No"} />
                <DataRow label="Claimed?" value={claimed ? "Yes" : "No"} />
                <DataRow label="Decryption pending?" value={pending ? "Yes" : "No"} />
                <DataRow
                  label="Known outcome"
                  value={
                    !claimed
                      ? "N/A — not claimed"
                      : wasPaid
                        ? "Paid"
                        : wasForeclosed
                          ? "Foreclosed (previously abandoned)"
                          : "Unknown (event lookup failed or empty)"
                  }
                />
              </div>

              {!hasPolicy ? (
                <p className="font-mono text-xs text-muted-foreground">
                  This address has no policy on RedoubtCoverPool.
                </p>
              ) : !pending ? (
                <p className="font-mono text-xs text-muted-foreground">
                  Nothing pending for this holder.
                </p>
              ) : (
                <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
                  <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-destructive">
                    <ShieldOff className="size-3.5" />
                    Danger zone — abandonStuckClaim(holder)
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {abandonEligible
                      ? "Eligible to abandon."
                      : eligibleAt !== undefined
                        ? `Not yet eligible — timeout elapses ${formatDeadline(eligibleAt, nowSec)}.`
                        : "Loading timeout…"}
                  </p>

                  {txHash && <TxConfirmationLink hash={txHash} label="Claim decryption abandoned" />}
                  {errorMessage && (
                    <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
                      <Ban data-icon="inline-start" />
                      <AlertTitle className="font-mono">FAILED</AlertTitle>
                      <AlertDescription>{errorMessage}</AlertDescription>
                    </Alert>
                  )}

                  {!confirmStep ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!abandonEligible}
                      onClick={() => setConfirmStep(true)}
                    >
                      Review consequence
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
                        <TriangleAlert data-icon="inline-start" />
                        <AlertTitle className="font-mono">THIS FORECLOSES THE CLAIM</AlertTitle>
                        <AlertDescription className="space-y-2">
                          <p>
                            This permanently marks this policy <code>claimed = true</code>. It
                            does NOT recover or pay out the holder&apos;s entitlement — it only
                            stops this specific stuck attempt from ever being retried, because
                            claim()&apos;s <code>confidentialTransfer</code> already executed
                            synchronously and unconditionally before the decryption got stuck.
                          </p>
                          <p>
                            If the stuck attempt actually transferred nothing, this holder is
                            now wrongly locked out of a legitimate claim forever. That&apos;s a
                            deliberate conservative trade against the alternative — allowing a
                            retry risks a real double payment, which undermines the exact
                            solvency guarantee checkSolvency exists to prove.
                          </p>
                        </AlertDescription>
                      </Alert>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={handleAbandon}
                        >
                          {busy ? "Submitting…" : "Confirm — abandonStuckClaim()"}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmStep(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
