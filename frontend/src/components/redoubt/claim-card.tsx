"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useConfig,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { zeroHash, type EIP1193Provider } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, Check, Clock, Gavel, Lock, ShieldOff, ShieldX, Unlock } from "lucide-react";
import { ABIS, CONTRACTS, POOL_STATUS, REDOUBT_CHAIN, REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK } from "@/lib/contracts";
import { getFhevmInstance, publicDecryptBool } from "@/lib/fhevm";
import { CaseFileFrame } from "./case-file-frame";
import { DataRow } from "./data-row";
import { TxConfirmationLink } from "./tx-confirmation-link";
import { OperationHud, type HudLogEntry } from "./crypto-process";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

type Phase = "idle" | "claiming" | "awaiting-decrypt" | "finalizing" | "success" | "error";

// Session-local only, by design (see the session 22 CLAUDE.md writeup): the
// contract emits NO event when finalizeClaim resolves fullyPaid == false --
// PremiumEpochWithheld/SolvencyChecked-style "here's what happened" events
// exist for the other two finalize* paths, but claim's failure branch is
// silent on purpose (§16: it's an expected outcome, not an error). That
// means "resolved false, retriable" and "never attempted" are genuinely
// indistinguishable on-chain after a reload -- this banner can only ever
// reflect what THIS browser session just watched happen, never a
// reconstructed history.
type LastOutcome = "paid" | "unpaid" | undefined;

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function ClaimCard() {
  const { address, connector, chainId } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [log, setLog] = useState<HudLogEntry[]>([]);
  const [claimTxHash, setClaimTxHash] = useState<`0x${string}`>();
  const [finalizeTxHash, setFinalizeTxHash] = useState<`0x${string}`>();
  const [lastOutcome, setLastOutcome] = useState<LastOutcome>();

  // Disambiguates policies(holder).claimed == true, which is set on BOTH a
  // successful finalizeClaim AND abandonStuckClaim (session 16) -- the flag
  // alone cannot tell "paid" from "foreclosed" apart. ClaimPaid only fires
  // on the success path; ClaimDecryptionAbandoned only on the foreclosure
  // path. Scanned from the pool's own verified deployment block, not
  // genesis (see contracts.ts).
  const [claimPaidCount, setClaimPaidCount] = useState<number>();
  const [abandonedCount, setAbandonedCount] = useState<number>();
  const [logsRefreshKey, setLogsRefreshKey] = useState(0);

  const onCorrectNetwork = Boolean(address) && chainId === REDOUBT_CHAIN.id;

  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "status" },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "policies", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "claimDecryptionPending", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "pendingClaimResult", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...poolContract, functionName: "MIN_HOLDING_EPOCHS" },
    ],
    query: { enabled: onCorrectNetwork, refetchInterval: 15_000 },
  });

  const [statusResult, epochResult, policyResult, pendingResult, handleResult, minHoldingResult] =
    reads ?? [];
  const statusIndex = statusResult?.result as number | undefined;
  const status = statusIndex !== undefined ? POOL_STATUS[statusIndex] : undefined;
  const currentEpoch = epochResult?.result as bigint | undefined;
  const policy = policyResult?.result as readonly [`0x${string}`, bigint, boolean] | undefined;
  const claimDecryptionPending = (pendingResult?.result as boolean | undefined) ?? false;
  const pendingClaimHandle = handleResult?.result as `0x${string}` | undefined;
  const minHoldingEpochs = minHoldingResult?.result as bigint | undefined;

  const coverageHandle = policy?.[0];
  const hasPolicy = coverageHandle !== undefined && coverageHandle !== zeroHash;
  const epochBought = policy?.[1];
  const claimed = policy?.[2] ?? false;

  const holdingPeriodElapsed =
    currentEpoch !== undefined && epochBought !== undefined && minHoldingEpochs !== undefined
      ? currentEpoch >= epochBought + minHoldingEpochs
      : undefined;

  // Resets when the wallet or the on-chain handle changes underneath it --
  // same convention as my-coverage-card (session 19).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase("idle");
    setErrorMessage(undefined);
    setLog([]);
    setClaimTxHash(undefined);
    setFinalizeTxHash(undefined);
    setLastOutcome(undefined);
  }, [address, coverageHandle]);

  useEffect(() => {
    if (!address || !publicClient || !onCorrectNetwork) return;
    let cancelled = false;
    (async () => {
      try {
        const [paid, abandoned] = await Promise.all([
          publicClient.getContractEvents({
            ...poolContract,
            eventName: "ClaimPaid",
            args: { holder: address },
            fromBlock: REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            ...poolContract,
            eventName: "ClaimDecryptionAbandoned",
            args: { holder: address },
            fromBlock: REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
        ]);
        if (!cancelled) {
          setClaimPaidCount(paid.length);
          setAbandonedCount(abandoned.length);
        }
      } catch {
        // Public-RPC log range limits are a real, known risk here (no
        // dedicated RPC provider is configured -- see contracts.ts) --
        // fail soft into "unknown," not a broken card. The claimed==true
        // + can't-tell-which-outcome case below already renders an honest
        // "claimed, outcome unknown" message for exactly this situation.
        if (!cancelled) {
          setClaimPaidCount(undefined);
          setAbandonedCount(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, onCorrectNetwork, logsRefreshKey]);

  async function runFinalizeChain(handle: `0x${string}`, startedAt: number) {
    if (!connector) throw new Error("Wallet connector unavailable.");
    setPhase("awaiting-decrypt");
    setLog((prev) => [
      ...prev,
      { label: "Requesting public decryption", atMs: Date.now() - startedAt },
    ]);
    const provider = (await connector.getProvider()) as EIP1193Provider;
    const instance = await getFhevmInstance(provider);
    const { cleartext, decryptionProof } = await publicDecryptBool(instance, handle);
    setLog((prev) => [
      ...prev,
      { label: "Decryption result received", atMs: Date.now() - startedAt },
    ]);

    setPhase("finalizing");
    setLog((prev) => [
      ...prev,
      { label: "Submitting finalizeClaim()", atMs: Date.now() - startedAt },
    ]);
    const finalizeHash = await writeContractAsync({
      ...poolContract,
      functionName: "finalizeClaim",
      args: [address as `0x${string}`, [BigInt(cleartext)], decryptionProof],
    });
    await waitForTransactionReceipt(config, { hash: finalizeHash });
    setFinalizeTxHash(finalizeHash);
    setLog((prev) => [
      ...prev,
      { label: "finalizeClaim() confirmed", atMs: Date.now() - startedAt },
    ]);

    setLastOutcome(cleartext === 1 ? "paid" : "unpaid");
    setLogsRefreshKey((k) => k + 1);
    await refetchReads();
    setPhase("success");
  }

  async function handleSubmitClaim() {
    if (!address) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setLog([{ label: "Submitting claim()", atMs: 0 }]);
    setPhase("claiming");
    try {
      const hash = await writeContractAsync({ ...poolContract, functionName: "claim" });
      await waitForTransactionReceipt(config, { hash });
      setClaimTxHash(hash);
      setLog((prev) => [
        ...prev,
        { label: "claim() confirmed", atMs: Date.now() - startedAt },
      ]);

      const fresh = await refetchReads();
      const handle = fresh.data?.[4]?.result as `0x${string}` | undefined;
      if (!handle || handle === zeroHash) {
        throw new Error("claim() confirmed but no pending decryption was found -- try reloading.");
      }
      await runFinalizeChain(handle, startedAt);
    } catch (e) {
      setLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleResumeFinalize() {
    if (!pendingClaimHandle || pendingClaimHandle === zeroHash) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setLog([{ label: "Resuming pending claim", atMs: 0 }]);
    try {
      await runFinalizeChain(pendingClaimHandle, startedAt);
    } catch (e) {
      setLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  if (!address) {
    return (
      <CaseFileFrame>
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Connect a wallet to view claim status.
        </p>
      </CaseFileFrame>
    );
  }

  if (!onCorrectNetwork) return null;

  const isBusy = phase === "claiming" || phase === "awaiting-decrypt" || phase === "finalizing";

  // ClaimPaid/ClaimDecryptionAbandoned are mutually exclusive by contract
  // construction (finalizeClaim sets claimed=true only alongside ClaimPaid;
  // abandonStuckClaim sets it with ClaimDecryptionAbandoned instead) --
  // both counts being defined and both being 0 means the logs loaded fine
  // but genuinely found nothing, a real (if contract-shouldn't-happen)
  // case worth rendering honestly rather than silently picking one.
  const outcomeKnown = claimPaidCount !== undefined && abandonedCount !== undefined;
  const wasPaid = outcomeKnown && (claimPaidCount ?? 0) > 0;
  const wasForeclosed = outcomeKnown && (abandonedCount ?? 0) > 0 && !wasPaid;

  let body: React.ReactNode;

  if (!hasPolicy) {
    body = (
      <p className="font-mono text-xs text-muted-foreground">
        This wallet has no open policy on RedoubtCoverPool. Buy cover first.
      </p>
    );
  } else if (claimDecryptionPending) {
    body = (
      <div className="space-y-3">
        <p className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          A claim for this policy is already submitted on-chain and waiting on its KMS
          decryption proof. This step is permissionless and resumable — reloading the page
          didn&apos;t lose anything.
        </p>
        <Button size="sm" disabled={isBusy} onClick={handleResumeFinalize}>
          <Unlock data-icon="inline-start" />
          {isBusy ? "Working…" : "Finalize claim"}
        </Button>
      </div>
    );
  } else if (claimed) {
    if (wasPaid) {
      body = (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-primary">
            <Check className="size-3.5" />
            Paid
          </div>
          <p className="font-mono text-[11px] text-muted-foreground/70">
            This policy&apos;s claim resolved with full payout. Consistent with §6&apos;s
            leakage table, only the fact that this address claimed is ever shown here — the
            payout amount stays encrypted.
          </p>
        </div>
      );
    } else if (wasForeclosed) {
      body = (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-destructive">
            <ShieldOff className="size-3.5" />
            Foreclosed
          </div>
          <p className="font-mono text-[11px] text-muted-foreground/70">
            A decryption for this claim stalled past the pool&apos;s timeout and was abandoned.
            Per this pool&apos;s design (session 16), that permanently forecloses retrying —
            even though a stuck attempt that actually transferred 0 would, in truth, have
            deserved a retry. This is a deliberate conservative trade against double-payment,
            not a bug.
          </p>
        </div>
      );
    } else {
      body = (
        <div className="space-y-2 rounded-md border border-line/70 bg-card/40 p-4">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <Gavel className="size-3.5" />
            Claimed — outcome unknown
          </div>
          <p className="font-mono text-[11px] text-muted-foreground/70">
            This policy is marked claimed, but the event log lookup that distinguishes a paid
            outcome from a foreclosed one didn&apos;t return a result (likely an RPC limit, not
            a contract fact). Check the transaction history for this address on Etherscan.
          </p>
        </div>
      );
    }
  } else if (status !== "ClaimWindowOpen") {
    body = (
      <p className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
        <ShieldX className="mt-0.5 size-3.5 shrink-0" />
        {status === "Active"
          ? "No claim window is open yet — claims only become possible after a public depeg triggers one."
          : "The claim window for this pool has already closed. No new claims can be filed against this policy."}
      </p>
    );
  } else if (holdingPeriodElapsed === false) {
    body = (
      <p className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
        <Clock className="mt-0.5 size-3.5 shrink-0" />
        This policy was bought in epoch {epochBought?.toString()} and is eligible to claim
        starting epoch {(epochBought ?? BigInt(0)) + (minHoldingEpochs ?? BigInt(0))} — the pool
        is currently in epoch {currentEpoch?.toString()}.
      </p>
    );
  } else {
    body = (
      <div className="space-y-3">
        {lastOutcome === "unpaid" && (
          <p className="flex items-start gap-2 rounded-md border border-line/70 bg-card/40 p-3 font-mono text-[11px] text-muted-foreground">
            <ShieldOff className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            Your last attempt didn&apos;t receive full payout — the pool&apos;s real balance
            may not have covered it. This is an expected outcome per this design, not an error;
            your policy is still unclaimed and you may attempt again.
          </p>
        )}
        <p className="font-mono text-xs text-muted-foreground">
          This policy is eligible to claim. Only the fact that this address claimed is ever
          made visible — never the payout amount.
        </p>
        <Button size="sm" disabled={isBusy} onClick={handleSubmitClaim}>
          <Lock data-icon="inline-start" />
          {isBusy ? "Working…" : "Claim"}
        </Button>
      </div>
    );
  }

  const hudIcon =
    phase === "error"
      ? Ban
      : phase === "success"
        ? Check
        : phase === "finalizing"
          ? Gavel
          : phase === "awaiting-decrypt"
            ? Unlock
            : Lock;
  const hudStatus = phase === "error" ? "error" : phase === "success" ? "success" : "active";
  const hudCaption =
    phase === "claiming"
      ? "Waiting for claim() to be mined — no client-side encryption needed, this call takes no arguments."
      : phase === "awaiting-decrypt"
        ? "Public decryption of the payout-success bit — typically 3.3-3.6 seconds on Sepolia, no wallet signature required."
        : phase === "finalizing"
          ? "Waiting for finalizeClaim() to be mined."
          : phase === "success"
            ? lastOutcome === "paid"
              ? "Claim resolved: paid in full."
              : "Claim resolved: not fully paid — retriable."
            : undefined;

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Claim Window
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">File a Claim</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {(claimTxHash || finalizeTxHash) && (
            <div className="space-y-2">
              {claimTxHash && <TxConfirmationLink hash={claimTxHash} label="Claim submitted" />}
              {finalizeTxHash && (
                <TxConfirmationLink hash={finalizeTxHash} label="Claim finalized" />
              )}
            </div>
          )}

          {hasPolicy && policy && (
            <>
              <DataRow label="Epoch bought" value={epochBought?.toString() ?? "—"} />
              <DataRow label="Claimed" value={claimed ? "Yes" : "No"} />
            </>
          )}

          {body}

          {(phase === "claiming" ||
            phase === "awaiting-decrypt" ||
            phase === "finalizing" ||
            phase === "success" ||
            phase === "error") && (
            <OperationHud
              status={hudStatus}
              icon={hudIcon}
              log={log}
              caption={hudCaption}
              errorMessage={phase === "error" ? errorMessage : undefined}
              onDismiss={() => {
                setPhase("idle");
                setErrorMessage(undefined);
              }}
            />
          )}
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
