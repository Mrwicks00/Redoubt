"use client";

import { useState } from "react";
import { useConfig, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits } from "viem";
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
import { ABIS, CONTRACTS } from "@/lib/contracts";
import { CaseFileFrame } from "../case-file-frame";
import { DataRow } from "../data-row";
import { TxConfirmationLink } from "../tx-confirmation-link";
import { useNowSeconds } from "./use-now-seconds";
import { formatDeadline } from "./format-time";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

const oracleContract = {
  address: CONTRACTS.mockPriceOracle,
  abi: ABIS.mockPriceOracle,
} as const;

const PRICE_DECIMALS = 8;

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

// The pool's two irreversible phase transitions (§5: no path back to
// Active). Neither involves FHE/decryption -- both read plain public facts
// (the oracle price, a fixed-duration deadline).
export function ClaimWindowCard() {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerError, setTriggerError] = useState<string>();
  const [triggerTxHash, setTriggerTxHash] = useState<`0x${string}`>();
  const [confirmStep, setConfirmStep] = useState(false);
  const [settleFirstAck, setSettleFirstAck] = useState(false);

  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string>();
  const [settleTxHash, setSettleTxHash] = useState<`0x${string}`>();

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "status" },
      { ...poolContract, functionName: "claimWindowOpenedAt" },
      { ...poolContract, functionName: "claimWindowDuration" },
      { ...poolContract, functionName: "depegThreshold" },
      { ...poolContract, functionName: "maxOracleStaleness" },
      { ...oracleContract, functionName: "latestPrice" },
      { ...oracleContract, functionName: "lastUpdated" },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "epochStartTimestamp" },
      { ...poolContract, functionName: "epochLength" },
    ],
    query: { refetchInterval: 15_000 },
  });

  const [
    statusR,
    openedAtR,
    durationR,
    thresholdR,
    staleR,
    priceR,
    updatedR,
    currentEpochR,
    epochStartR,
    epochLengthR,
  ] = reads ?? [];
  const statusIndex = statusR?.result as number | undefined;
  const status = statusIndex === 0 ? "Active" : statusIndex === 1 ? "ClaimWindowOpen" : statusIndex === 2 ? "Settled" : undefined;
  const claimWindowOpenedAt = openedAtR?.result as bigint | undefined;
  const claimWindowDuration = durationR?.result as bigint | undefined;
  const depegThreshold = thresholdR?.result as bigint | undefined;
  const maxOracleStaleness = staleR?.result as bigint | undefined;
  const latestPrice = priceR?.result as bigint | undefined;
  const lastUpdated = updatedR?.result as bigint | undefined;
  const currentEpoch = currentEpochR?.result as bigint | undefined;
  const epochStart = epochStartR?.result as bigint | undefined;
  const epochLength = epochLengthR?.result as bigint | undefined;

  const nowSec = useNowSeconds();
  const oracleAge = nowSec !== undefined && lastUpdated !== undefined ? nowSec - lastUpdated : undefined;
  const isStale = oracleAge !== undefined && maxOracleStaleness !== undefined ? oracleAge > maxOracleStaleness : undefined;
  const belowThreshold = latestPrice !== undefined && depegThreshold !== undefined ? latestPrice < depegThreshold : undefined;
  const triggerEligible = status === "Active" && belowThreshold === true && isStale === false;

  // Mirrors epoch-settlement-card.tsx's own settleEpochEligible check exactly
  // -- same fields, same comparison -- so "settle first" here means the same
  // thing "eligible to settleEpoch()" already means over there.
  const epochEndsAt = epochStart !== undefined && epochLength !== undefined ? epochStart + epochLength : undefined;
  const settleFirstNeeded =
    status === "Active" && nowSec !== undefined && epochEndsAt !== undefined && nowSec >= epochEndsAt;

  const closesAt =
    claimWindowOpenedAt !== undefined && claimWindowDuration !== undefined
      ? claimWindowOpenedAt + claimWindowDuration
      : undefined;
  const settleEligible = status === "ClaimWindowOpen" && nowSec !== undefined && closesAt !== undefined && nowSec >= closesAt;

  async function handleTrigger() {
    setTriggerError(undefined);
    setTriggerBusy(true);
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "triggerClaimWindow" });
      await waitForTransactionReceipt(config, { hash });
      setTriggerTxHash(hash);
      setConfirmStep(false);
      setSettleFirstAck(false);
      await refetch();
    } catch (e) {
      setTriggerError(describeError(e));
    } finally {
      setTriggerBusy(false);
    }
  }

  async function handleSettle() {
    setSettleError(undefined);
    setSettleBusy(true);
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "settleClaimWindow" });
      await waitForTransactionReceipt(config, { hash });
      setSettleTxHash(hash);
      await refetch();
    } catch (e) {
      setSettleError(describeError(e));
    } finally {
      setSettleBusy(false);
    }
  }

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Permissionless · callable by anyone · irreversible
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Claim Window</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-[11px] text-muted-foreground/70">
            No path back to Active (§5). triggerClaimWindow only checks a public, objective
            fact — the oracle price crossing depegThreshold — no decryption involved.
          </p>

          <div>
            <DataRow label="Pool status" value={status ?? "—"} />
            <DataRow
              label="Price vs. threshold"
              value={
                latestPrice !== undefined && depegThreshold !== undefined
                  ? `${formatUnits(latestPrice, PRICE_DECIMALS)} / ${formatUnits(depegThreshold, PRICE_DECIMALS)}`
                  : "—"
              }
            />
            <DataRow label="Oracle stale?" value={isStale === undefined ? "—" : isStale ? "Yes" : "No"} />
          </div>

          {triggerTxHash && <TxConfirmationLink hash={triggerTxHash} label="Claim window triggered" />}
          {triggerError && (
            <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
              <Ban data-icon="inline-start" />
              <AlertTitle className="font-mono">FAILED</AlertTitle>
              <AlertDescription>{triggerError}</AlertDescription>
            </Alert>
          )}

          {!confirmStep ? (
            <>
              <Button
                size="sm"
                disabled={!triggerEligible || triggerBusy}
                onClick={() => setConfirmStep(true)}
              >
                Review consequence
              </Button>
              {!triggerEligible && status === "Active" && (
                <p className="font-mono text-[11px] text-muted-foreground/70">
                  Not eligible yet — needs price below threshold and a fresh (non-stale) oracle
                  update.
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-destructive">
                <ShieldOff className="size-3.5" />
                Danger zone — triggerClaimWindow()
              </div>
              <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
                <TriangleAlert data-icon="inline-start" />
                <AlertTitle className="font-mono">THIS CANNOT BE UNDONE</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    Triggering the claim window permanently moves this pool out of{" "}
                    <code>Active</code>. There is no path back (§5) — once triggered,{" "}
                    <code>buyCover()</code> and <code>settleEpoch()</code> can never be called
                    again for this pool instance.
                  </p>
                  <p>
                    Current epoch is <strong>{currentEpoch?.toString() ?? "—"}</strong>. Any
                    policy bought in epoch {currentEpoch?.toString() ?? "N"} will never become
                    claim-eligible if you trigger now — it can&apos;t yet satisfy
                    MIN_HOLDING_EPOCHS, and no later epoch will ever arrive once this pool
                    leaves Active.
                  </p>
                  {settleFirstNeeded && (
                    <p>
                      ⚠ The current epoch has already ended and hasn&apos;t been settled. Call{" "}
                      <code>settleEpoch()</code> first — otherwise any policy bought in this
                      epoch may never become claim-eligible once you trigger the claim window.
                      See the{" "}
                      <a href="#epoch-settlement" className="text-primary underline underline-offset-4">
                        Epoch Settlement
                      </a>{" "}
                      section on this page.
                    </p>
                  )}
                </AlertDescription>
              </Alert>

              {settleFirstNeeded && (
                <label className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={settleFirstAck}
                    onChange={(e) => setSettleFirstAck(e.target.checked)}
                    className="mt-0.5"
                  />
                  I understand any pending policy from this epoch will become permanently
                  unclaimable.
                </label>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={triggerBusy || (settleFirstNeeded && !settleFirstAck)}
                  onClick={handleTrigger}
                >
                  {triggerBusy ? "Submitting…" : "Confirm — triggerClaimWindow()"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={triggerBusy}
                  onClick={() => {
                    setConfirmStep(false);
                    setSettleFirstAck(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="border-t border-line/60 pt-4">
            <DataRow
              label="Claim window closes"
              value={closesAt !== undefined ? formatDeadline(closesAt, nowSec) : "—"}
            />
            {settleTxHash && <TxConfirmationLink hash={settleTxHash} label="Claim window settled" />}
            {settleError && (
              <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
                <Ban data-icon="inline-start" />
                <AlertTitle className="font-mono">FAILED</AlertTitle>
                <AlertDescription>{settleError}</AlertDescription>
              </Alert>
            )}
            <Button size="sm" className="mt-3" disabled={!settleEligible || settleBusy} onClick={handleSettle}>
              {settleBusy ? "Submitting…" : "settleClaimWindow()"}
            </Button>
            {status === "ClaimWindowOpen" && !settleEligible && (
              <p className="mt-2 font-mono text-[11px] text-muted-foreground/70">
                Claims already in flight resolve normally after Settled — this only blocks
                new claim() calls once closed.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
