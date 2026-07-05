"use client";

import { useState } from "react";
import { useAccount, useConfig, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { type EIP1193Provider } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Ban, Check, Gavel, ShieldOff, Unlock } from "lucide-react";
import { ABIS, CONTRACTS } from "@/lib/contracts";
import { getFhevmInstance, publicDecryptBool, publicDecryptUint } from "@/lib/fhevm";
import { CaseFileFrame } from "../case-file-frame";
import { DataRow } from "../data-row";
import { TxConfirmationLink } from "../tx-confirmation-link";
import { OperationHud, type HudLogEntry } from "../crypto-process";
import { useNowSeconds } from "./use-now-seconds";
import { formatDeadline } from "./format-time";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

// Purely derived from on-chain pending flags -- resumable across reload,
// same principle claim-card.tsx uses for its own pending/handle reads.
// "idle" means no pipeline stage is in flight; settleEpoch() itself is the
// idle-stage action.
type Stage = "idle" | "count" | "valueCheck" | "premiumTotal";

type Phase = "idle" | "submitting" | "decrypting" | "finalizing" | "success" | "error";

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

// §0 session 15/16's four-stage pull-model pipeline: settleEpoch() snapshots
// the epoch, then three permissionless finalize* calls advance it one
// decrypt at a time (count -> value-check bit -> premium total). Each stage
// is its own real relayer round trip, so this card advances ONE stage per
// click and re-derives what's next from chain state, rather than
// auto-chaining all three silently.
export function EpochSettlementCard() {
  const { connector } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [log, setLog] = useState<HudLogEntry[]>([]);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}`>();
  const [abandonBusy, setAbandonBusy] = useState(false);
  const [abandonError, setAbandonError] = useState<string>();
  const [abandonTxHash, setAbandonTxHash] = useState<`0x${string}`>();

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "status" },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "epochStartTimestamp" },
      { ...poolContract, functionName: "epochLength" },
      { ...poolContract, functionName: "participantCountDecryptionPending" },
      { ...poolContract, functionName: "premiumValueCheckPending" },
      { ...poolContract, functionName: "premiumDecryptionPending" },
      { ...poolContract, functionName: "settlementPendingSince" },
      { ...poolContract, functionName: "decryptionTimeout" },
      { ...poolContract, functionName: "pendingSettlementEpoch" },
      { ...poolContract, functionName: "pendingRevealedParticipantCount" },
      { ...poolContract, functionName: "participantCountAwaitingDecryption" },
      { ...poolContract, functionName: "pendingPremiumValueCheck" },
      { ...poolContract, functionName: "premiumsAwaitingDecryption" },
      { ...poolContract, functionName: "publicReserves" },
    ],
    query: { refetchInterval: 15_000 },
  });

  const [
    statusR,
    currentEpochR,
    epochStartR,
    epochLengthR,
    countPendingR,
    valueCheckPendingR,
    premiumPendingR,
    pendingSinceR,
    timeoutR,
    pendingEpochR,
    revealedCountR,
    countHandleR,
    valueCheckHandleR,
    premiumHandleR,
    publicReservesR,
  ] = reads ?? [];

  const statusIndex = statusR?.result as number | undefined;
  const status = statusIndex === 0 ? "Active" : statusIndex === 1 ? "ClaimWindowOpen" : statusIndex === 2 ? "Settled" : undefined;
  const currentEpoch = currentEpochR?.result as bigint | undefined;
  const epochStart = epochStartR?.result as bigint | undefined;
  const epochLength = epochLengthR?.result as bigint | undefined;
  const countPending = (countPendingR?.result as boolean | undefined) ?? false;
  const valueCheckPending = (valueCheckPendingR?.result as boolean | undefined) ?? false;
  const premiumPending = (premiumPendingR?.result as boolean | undefined) ?? false;
  const pendingSince = pendingSinceR?.result as bigint | undefined;
  const decryptionTimeout = timeoutR?.result as bigint | undefined;
  const pendingEpoch = pendingEpochR?.result as bigint | undefined;
  const revealedCount = revealedCountR?.result as bigint | undefined;
  const countHandle = countHandleR?.result as `0x${string}` | undefined;
  const valueCheckHandle = valueCheckHandleR?.result as `0x${string}` | undefined;
  const premiumHandle = premiumHandleR?.result as `0x${string}` | undefined;
  const publicReserves = publicReservesR?.result as bigint | undefined;

  const stage: Stage = countPending ? "count" : valueCheckPending ? "valueCheck" : premiumPending ? "premiumTotal" : "idle";

  const nowSec = useNowSeconds();
  const epochEndsAt = epochStart !== undefined && epochLength !== undefined ? epochStart + epochLength : undefined;
  const settleEpochEligible = status === "Active" && nowSec !== undefined && epochEndsAt !== undefined && nowSec >= epochEndsAt;

  const abandonEligibleAt =
    pendingSince !== undefined && decryptionTimeout !== undefined && pendingSince > BigInt(0)
      ? pendingSince + decryptionTimeout
      : undefined;
  const abandonEligible =
    stage !== "idle" && nowSec !== undefined && abandonEligibleAt !== undefined && nowSec >= abandonEligibleAt;
  const abandonStageNum = stage === "count" ? 1 : stage === "valueCheck" ? 2 : stage === "premiumTotal" ? 3 : undefined;

  async function handleSettleEpoch() {
    setErrorMessage(undefined);
    setPhase("submitting");
    setLog([{ label: "Submitting settleEpoch()", atMs: 0 }]);
    const startedAt = Date.now();
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "settleEpoch" });
      await waitForTransactionReceipt(config, { hash });
      setLastTxHash(hash);
      setLog((prev) => [...prev, { label: "settleEpoch() confirmed", atMs: Date.now() - startedAt }]);
      await refetch();
      setPhase("success");
    } catch (e) {
      setLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleAdvanceFinalize() {
    if (!connector) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setLog([{ label: "Requesting public decryption", atMs: 0 }]);
    setPhase("decrypting");
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const instance = await getFhevmInstance(provider);

      let finalizeFunctionName: "finalizeParticipantCount" | "finalizePremiumValueCheck" | "finalizePremiumSettlement";
      let cleartextArg: bigint;
      let decryptionProof: `0x${string}`;

      if (stage === "count") {
        if (!countHandle) throw new Error("No participant-count handle to decrypt.");
        const { value, decryptionProof: proof } = await publicDecryptUint(instance, countHandle);
        cleartextArg = value;
        decryptionProof = proof;
        finalizeFunctionName = "finalizeParticipantCount";
      } else if (stage === "valueCheck") {
        if (!valueCheckHandle) throw new Error("No value-check handle to decrypt.");
        const { cleartext, decryptionProof: proof } = await publicDecryptBool(instance, valueCheckHandle);
        cleartextArg = BigInt(cleartext);
        decryptionProof = proof;
        finalizeFunctionName = "finalizePremiumValueCheck";
      } else if (stage === "premiumTotal") {
        if (!premiumHandle) throw new Error("No premium-total handle to decrypt.");
        const { value, decryptionProof: proof } = await publicDecryptUint(instance, premiumHandle);
        cleartextArg = value;
        decryptionProof = proof;
        finalizeFunctionName = "finalizePremiumSettlement";
      } else {
        return;
      }

      setLog((prev) => [...prev, { label: "Decryption result received", atMs: Date.now() - startedAt }]);
      setPhase("finalizing");
      setLog((prev) => [...prev, { label: `Submitting ${finalizeFunctionName}()`, atMs: Date.now() - startedAt }]);
      const hash = await writeContractAsync({
        ...poolContract,
        functionName: finalizeFunctionName,
        args: [[cleartextArg], decryptionProof],
      });
      await waitForTransactionReceipt(config, { hash });
      setLastTxHash(hash);
      setLog((prev) => [...prev, { label: `${finalizeFunctionName}() confirmed`, atMs: Date.now() - startedAt }]);
      await refetch();
      setPhase("success");
    } catch (e) {
      setLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleAbandon() {
    setAbandonError(undefined);
    setAbandonBusy(true);
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "abandonStuckSettlement" });
      await waitForTransactionReceipt(config, { hash });
      setAbandonTxHash(hash);
      await refetch();
    } catch (e) {
      setAbandonError(describeError(e));
    } finally {
      setAbandonBusy(false);
    }
  }

  const isBusy = phase === "submitting" || phase === "decrypting" || phase === "finalizing";

  const hudIcon = phase === "error" ? Ban : phase === "success" ? Check : phase === "finalizing" ? Gavel : Unlock;
  const hudStatus = phase === "error" ? "error" : phase === "success" ? "success" : "active";

  return (
    <CaseFileFrame>
      <Card id="epoch-settlement" className="border-line/70 bg-transparent shadow-none scroll-mt-6">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Permissionless · callable by anyone
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Epoch Settlement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-[11px] text-muted-foreground/70">
            settleEpoch() → finalizeParticipantCount() → finalizePremiumValueCheck() →
            finalizePremiumSettlement(). Four stages, each a real transaction — the count and
            value-check bit must clear their thresholds before the premium total is ever marked
            decryptable at all.
          </p>

          <div>
            <DataRow label="Pool status" value={status ?? "—"} />
            <DataRow label="Current epoch" value={currentEpoch?.toString() ?? "—"} />
            <DataRow label="Public reserves (base units)" value={publicReserves?.toString() ?? "—"} />
            <DataRow
              label="Current stage"
              value={
                stage === "idle"
                  ? "None pending"
                  : stage === "count"
                    ? "1 — participant count decryption"
                    : stage === "valueCheck"
                      ? "2 — premium value-check bit"
                      : "3 — premium total decryption"
              }
            />
            {pendingEpoch !== undefined && stage !== "idle" && (
              <DataRow label="Settling epoch" value={pendingEpoch.toString()} />
            )}
            {revealedCount !== undefined && stage !== "idle" && stage !== "count" && (
              <DataRow label="Revealed participant count" value={revealedCount.toString()} />
            )}
          </div>

          {stage === "idle" && !settleEpochEligible && (
            <p className="font-mono text-xs text-muted-foreground">
              {status !== "Active"
                ? "settleEpoch() only runs while the pool is Active."
                : epochEndsAt !== undefined
                  ? `Not yet eligible — epoch ends ${formatDeadline(epochEndsAt, nowSec)}.`
                  : "Loading epoch timing…"}
            </p>
          )}

          {lastTxHash && <TxConfirmationLink hash={lastTxHash} label="Transaction confirmed" />}

          <Button
            size="sm"
            disabled={isBusy || (stage === "idle" && !settleEpochEligible)}
            onClick={stage === "idle" ? handleSettleEpoch : handleAdvanceFinalize}
          >
            {isBusy ? "Working…" : stage === "idle" ? "settleEpoch()" : `Advance stage ${abandonStageNum}`}
          </Button>

          {isBusy || phase === "success" || phase === "error" ? (
            <OperationHud
              status={hudStatus}
              icon={hudIcon}
              log={log}
              errorMessage={phase === "error" ? errorMessage : undefined}
              onDismiss={() => {
                setPhase("idle");
                setErrorMessage(undefined);
              }}
            />
          ) : null}

          <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-destructive">
              <ShieldOff className="size-3.5" />
              Danger zone — abandonStuckSettlement()
            </div>
            <p className="font-mono text-[11px] text-muted-foreground/80">
              Only for a decryption permanently lost (KMS data loss), not ordinary relayer
              downtime — a publicly-decryptable handle never expires, so finalize* can still
              succeed whenever a fresh proof shows up. For stage 1/2 this rolls the count and
              premium total forward, unrevealed. For stage 3, the premium total was already
              marked publicly decryptable by finalizePremiumValueCheck — abandoning only
              means this pool never formalizes it into publicReserves via this stuck cycle; it
              does not un-reveal anything already exposed off-chain.
            </p>
            {stage === "idle" ? (
              <p className="font-mono text-xs text-muted-foreground">Nothing pending.</p>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                {abandonEligible
                  ? `Eligible to abandon (stage ${abandonStageNum}).`
                  : abandonEligibleAt !== undefined
                    ? `Not yet eligible — timeout elapses ${formatDeadline(abandonEligibleAt, nowSec)}.`
                    : "Loading timeout…"}
              </p>
            )}
            {abandonTxHash && <TxConfirmationLink hash={abandonTxHash} label="Settlement abandoned" />}
            {abandonError && (
              <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
                <Ban data-icon="inline-start" />
                <AlertTitle className="font-mono">FAILED</AlertTitle>
                <AlertDescription>{abandonError}</AlertDescription>
              </Alert>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={!abandonEligible || abandonBusy}
              onClick={handleAbandon}
            >
              {abandonBusy ? "Submitting…" : "abandonStuckSettlement()"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
