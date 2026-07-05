"use client";

import { useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
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
import { ABIS, CONTRACTS, REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK } from "@/lib/contracts";
import { getFhevmInstance, publicDecryptBool } from "@/lib/fhevm";
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

type Phase = "idle" | "checking" | "decrypting" | "finalizing" | "success" | "error";

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

// §0 session 15's rate-limited solvency check: checkSolvency() -> (real
// KMS decrypt) -> finalizeSolvencyCheck(). Never reveals totalLiabilities
// or publicReserves themselves, only the solvent/insolvent bit (§4/§6).
export function SolvencyCheckCard() {
  const { connector } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [log, setLog] = useState<HudLogEntry[]>([]);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}`>();
  const [abandonBusy, setAbandonBusy] = useState(false);
  const [abandonError, setAbandonError] = useState<string>();
  const [abandonTxHash, setAbandonTxHash] = useState<`0x${string}`>();

  // Last publicly recorded result, sourced from the SolvencyChecked event
  // log rather than any local state -- otherwise the bit is only ever
  // visible in the single browser session that requested it. Unindexed,
  // pool-wide event (no per-caller filter possible), scanned from the same
  // verified deployment block claim-card.tsx already uses.
  const [lastRecordedSolvent, setLastRecordedSolvent] = useState<boolean>();

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "solvencyCheckPending" },
      { ...poolContract, functionName: "solvencyCheckPendingSince" },
      { ...poolContract, functionName: "lastSolvencyCheckEpoch" },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "pendingSolvencyResult" },
      { ...poolContract, functionName: "decryptionTimeout" },
    ],
    query: { refetchInterval: 15_000 },
  });

  const [pendingR, pendingSinceR, lastCheckEpochR, currentEpochR, handleR, timeoutR] = reads ?? [];
  const pending = (pendingR?.result as boolean | undefined) ?? false;
  const pendingSince = pendingSinceR?.result as bigint | undefined;
  const lastSolvencyCheckEpoch = lastCheckEpochR?.result as bigint | undefined;
  const currentEpoch = currentEpochR?.result as bigint | undefined;
  const handle = handleR?.result as `0x${string}` | undefined;
  const decryptionTimeout = timeoutR?.result as bigint | undefined;

  const neverSentinel = BigInt(2) ** BigInt(256) - BigInt(1);
  const alreadyCheckedThisEpoch =
    lastSolvencyCheckEpoch !== undefined &&
    currentEpoch !== undefined &&
    lastSolvencyCheckEpoch !== neverSentinel &&
    lastSolvencyCheckEpoch === currentEpoch;

  const nowSec = useNowSeconds();
  const abandonEligibleAt =
    pendingSince !== undefined && decryptionTimeout !== undefined && pendingSince > BigInt(0)
      ? pendingSince + decryptionTimeout
      : undefined;
  const abandonEligible =
    pending && nowSec !== undefined && abandonEligibleAt !== undefined && nowSec >= abandonEligibleAt;

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const events = await publicClient.getContractEvents({
          ...poolContract,
          eventName: "SolvencyChecked",
          fromBlock: REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK,
          toBlock: "latest",
        });
        const latest = events.at(-1) as unknown as { args?: { solvent?: boolean } } | undefined;
        const solvent = latest?.args?.solvent;
        if (!cancelled) setLastRecordedSolvent(solvent);
      } catch {
        if (!cancelled) setLastRecordedSolvent(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, lastTxHash]);

  async function handleCheckSolvency() {
    setErrorMessage(undefined);
    setPhase("checking");
    setLog([{ label: "Submitting checkSolvency()", atMs: 0 }]);
    const startedAt = Date.now();
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "checkSolvency" });
      await waitForTransactionReceipt(config, { hash });
      setLastTxHash(hash);
      setLog((prev) => [...prev, { label: "checkSolvency() confirmed", atMs: Date.now() - startedAt }]);
      await refetch();
      setPhase("success");
    } catch (e) {
      setLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleFinalize() {
    if (!connector || !handle) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setLog([{ label: "Requesting public decryption", atMs: 0 }]);
    setPhase("decrypting");
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const instance = await getFhevmInstance(provider);
      const { cleartext, decryptionProof } = await publicDecryptBool(instance, handle);
      setLog((prev) => [...prev, { label: "Decryption result received", atMs: Date.now() - startedAt }]);

      setPhase("finalizing");
      setLog((prev) => [...prev, { label: "Submitting finalizeSolvencyCheck()", atMs: Date.now() - startedAt }]);
      const hash = await writeContractAsync({
        ...poolContract,
        functionName: "finalizeSolvencyCheck",
        args: [[BigInt(cleartext)], decryptionProof],
      });
      await waitForTransactionReceipt(config, { hash });
      setLastTxHash(hash);
      setLog((prev) => [...prev, { label: "finalizeSolvencyCheck() confirmed", atMs: Date.now() - startedAt }]);
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
      const hash = await writeContractAsync({ ...poolContract, functionName: "abandonStuckSolvencyCheck" });
      await waitForTransactionReceipt(config, { hash });
      setAbandonTxHash(hash);
      await refetch();
    } catch (e) {
      setAbandonError(describeError(e));
    } finally {
      setAbandonBusy(false);
    }
  }

  const isBusy = phase === "checking" || phase === "decrypting" || phase === "finalizing";
  const hudIcon = phase === "error" ? Ban : phase === "success" ? Check : phase === "finalizing" ? Gavel : Unlock;
  const hudStatus = phase === "error" ? "error" : phase === "success" ? "success" : "active";

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Permissionless · callable by anyone
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Solvency Check</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-[11px] text-muted-foreground/70">
            Reveals one bit — solvent: true/false — never totalLiabilities or publicReserves
            themselves. Rate-limited to once per currentEpoch (session 15) to stop bracketing a
            single buyCover between two checks.
          </p>

          <div>
            <DataRow label="Current epoch" value={currentEpoch?.toString() ?? "—"} />
            <DataRow
              label="Already checked this epoch?"
              value={alreadyCheckedThisEpoch ? "Yes" : "No"}
            />
            <DataRow label="Check pending?" value={pending ? "Yes" : "No"} />
            <DataRow
              label="Last recorded result"
              value={lastRecordedSolvent === undefined ? "Unknown" : lastRecordedSolvent ? "Solvent" : "Insolvent"}
            />
          </div>

          {lastTxHash && <TxConfirmationLink hash={lastTxHash} label="Transaction confirmed" />}

          <Button
            size="sm"
            disabled={isBusy || (!pending && alreadyCheckedThisEpoch)}
            onClick={pending ? handleFinalize : handleCheckSolvency}
          >
            {isBusy ? "Working…" : pending ? "Finalize solvency check" : "checkSolvency()"}
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
              Danger zone — abandonStuckSolvencyCheck()
            </div>
            <p className="font-mono text-[11px] text-muted-foreground/80">
              Only for a permanently lost decryption, not ordinary downtime. Resets
              lastSolvencyCheckEpoch to the &quot;never&quot; sentinel so a fresh check can run
              immediately, even in the same epoch — the abandoned bit was never finalized, so
              the once-per-epoch guard has nothing to protect here.
            </p>
            {!pending ? (
              <p className="font-mono text-xs text-muted-foreground">Nothing pending.</p>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                {abandonEligible
                  ? "Eligible to abandon."
                  : abandonEligibleAt !== undefined
                    ? `Not yet eligible — timeout elapses ${formatDeadline(abandonEligibleAt, nowSec)}.`
                    : "Loading timeout…"}
              </p>
            )}
            {abandonTxHash && <TxConfirmationLink hash={abandonTxHash} label="Solvency check abandoned" />}
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
              {abandonBusy ? "Submitting…" : "abandonStuckSolvencyCheck()"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
