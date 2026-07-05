"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConfig, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { bytesToHex, parseUnits, zeroAddress, zeroHash, type EIP1193Provider } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, Check, Lock, ShieldCheck, ShieldX } from "lucide-react";
import { ABIS, CONTRACTS, POOL_STATUS, REDOUBT_CHAIN } from "@/lib/contracts";
import { TIMING_TIER } from "@/lib/timing";
import { getFhevmInstance } from "@/lib/fhevm";
import { CaseFileFrame } from "./case-file-frame";
import { DataRow } from "./data-row";
import { TxConfirmationLink } from "./tx-confirmation-link";
import { OperationHud, type HudLogEntry } from "./crypto-process";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

const tokenContract = {
  address: CONTRACTS.premiumToken,
  abi: ABIS.ierc7984,
} as const;

// setOperator's `until` is caller-supplied, not contract-mandated -- 30 days
// is a UI choice so a demo user isn't asked to re-grant on every visit.
// Session 10's own Node script used 1 day, but that was for a single
// scratch session, not a repeatable app.
const OPERATOR_GRANT_SECONDS = 30 * 24 * 60 * 60;

// The three real sub-steps of createEncryptedInput(...).encrypt() named in
// this file's own history (see CLAUDE.md session 18/20) -- cycled by an
// elapsed-time heuristic against TIMING_TIER.encryptedInput's measured
// range, since the SDK gives no real intermediate callback to key off.
const ENCRYPT_STAGE_LABELS = [
  "Encrypting value client-side",
  "Generating zero-knowledge proof",
  "Packaging encrypted input",
] as const;

type Phase = "idle" | "granting-operator" | "encrypting" | "buying" | "success" | "error";

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function BuyCoverCard() {
  const { address, connector, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [operationStartedAt, setOperationStartedAt] = useState<number>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [log, setLog] = useState<HudLogEntry[]>([]);
  const [grantOperatorTxHash, setGrantOperatorTxHash] = useState<`0x${string}`>();
  const [buyCoverTxHash, setBuyCoverTxHash] = useState<`0x${string}`>();
  const loggedEncryptStageRef = useRef(0);

  const onCorrectNetwork = Boolean(address) && chainId === REDOUBT_CHAIN.id;

  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      {
        ...tokenContract,
        functionName: "isOperator",
        args: [address ?? zeroAddress, CONTRACTS.redoubtCoverPool],
      },
      { ...tokenContract, functionName: "decimals" },
      { ...tokenContract, functionName: "symbol" },
      { ...poolContract, functionName: "policies", args: [address ?? zeroAddress] },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "status" },
    ],
    query: { enabled: onCorrectNetwork, refetchInterval: 15_000 },
  });

  const [isOperatorResult, decimalsResult, symbolResult, policyResult, currentEpochResult, statusResult] =
    reads ?? [];
  const isOperator = isOperatorResult?.result as boolean | undefined;
  const decimals = (decimalsResult?.result as number | undefined) ?? 6;
  const symbol = (symbolResult?.result as string | undefined) ?? "cUSDCMock";
  const policy = policyResult?.result as readonly [`0x${string}`, bigint, boolean] | undefined;
  const currentEpoch = currentEpochResult?.result as bigint | undefined;
  const statusIndex = statusResult?.result as number | undefined;
  const status = statusIndex !== undefined ? POOL_STATUS[statusIndex] : undefined;

  const hasOpenPolicy = policy !== undefined && policy[0] !== zeroHash;
  // §5: no path back to Active once the claim window has opened -- buyCover
  // itself reverts with "not in active phase" for anyone without an existing
  // policy. Gate the form on this instead of letting a new buyer's wallet
  // pop up, wait 28-50s for a real encrypted input, and then revert.
  const poolAcceptingNewCover = status === undefined ? undefined : status === "Active";

  // Pre-warm the FHEVM instance (Session 10 measured createInstance()'s
  // one-time public-key/CRS fetch at ~10s, separate from the ~28-50s
  // per-call encrypt()) as soon as a wallet is connected on the right
  // chain, so only the genuinely per-call cost is paid at submit time.
  useEffect(() => {
    if (!onCorrectNetwork || !connector) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = (await connector.getProvider()) as EIP1193Provider;
        if (!cancelled) await getFhevmInstance(provider);
      } catch {
        // Silent -- a pre-warm failure just means submit pays the cost
        // (and surfaces the error) itself.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onCorrectNetwork, connector]);

  // Live clock for the HUD's log timestamps, ticking through both real
  // network-bound phases (not just encrypting) so the transmission feed
  // reads as one continuous operation rather than resetting per phase.
  useEffect(() => {
    if (!operationStartedAt || (phase !== "encrypting" && phase !== "buying")) return;
    const id = setInterval(() => setElapsedMs(Date.now() - operationStartedAt), 1000);
    return () => clearInterval(id);
  }, [phase, operationStartedAt]);

  // Advances the HUD log through encrypt's 3 real named sub-steps as elapsed
  // time crosses heuristic thresholds -- a pacing cue, not a progress signal
  // the SDK actually emits (it emits none; see lib/timing.ts).
  useEffect(() => {
    if (phase !== "encrypting") {
      loggedEncryptStageRef.current = 0;
      return;
    }
    const fraction = elapsedMs / TIMING_TIER.encryptedInput.estimateMs;
    const targetStage = fraction < 0.35 ? 0 : fraction < 0.8 ? 1 : 2;
    if (targetStage > loggedEncryptStageRef.current) {
      loggedEncryptStageRef.current = targetStage;
      setLog((prev) => [...prev, { label: ENCRYPT_STAGE_LABELS[targetStage], atMs: elapsedMs }]);
    }
  }, [phase, elapsedMs]);

  async function handleGrantOperator() {
    if (!address) return;
    setErrorMessage(undefined);
    setPhase("granting-operator");
    try {
      const until = Math.floor(Date.now() / 1000) + OPERATOR_GRANT_SECONDS;
      const hash = await writeContractAsync({
        ...tokenContract,
        functionName: "setOperator",
        args: [CONTRACTS.redoubtCoverPool, until],
      });
      await waitForTransactionReceipt(config, { hash });
      setGrantOperatorTxHash(hash);
      await refetchReads();
      setPhase("idle");
    } catch (e) {
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleBuyCover() {
    if (!address || !connector || !amount) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setOperationStartedAt(startedAt);
    setElapsedMs(0);
    setLog([{ label: ENCRYPT_STAGE_LABELS[0], atMs: 0 }]);
    try {
      const coverageBaseUnits = parseUnits(amount, decimals);

      setPhase("encrypting");
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const instance = await getFhevmInstance(provider);
      const input = instance.createEncryptedInput(CONTRACTS.redoubtCoverPool, address);
      input.add64(coverageBaseUnits);
      const { handles, inputProof } = await input.encrypt();

      setPhase("buying");
      setLog((prev) => [
        ...prev,
        { label: "Submitting buyCover()", atMs: Date.now() - startedAt },
      ]);
      const hash = await writeContractAsync({
        ...poolContract,
        functionName: "buyCover",
        args: [bytesToHex(handles[0]), bytesToHex(inputProof)],
      });
      await waitForTransactionReceipt(config, { hash });
      setBuyCoverTxHash(hash);
      await refetchReads();
      setLog((prev) => [
        ...prev,
        { label: "Transaction confirmed", atMs: Date.now() - startedAt },
      ]);
      setPhase("success");
      setAmount("");
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
          Connect a wallet to buy cover.
        </p>
      </CaseFileFrame>
    );
  }

  if (!onCorrectNetwork) return null;

  const isBusy = phase === "granting-operator" || phase === "encrypting" || phase === "buying";

  const hudIcon =
    phase === "error" ? Ban : phase === "success" ? Check : phase === "buying" ? ShieldCheck : Lock;
  const hudStatus = phase === "error" ? "error" : phase === "success" ? "success" : "active";
  const hudCaption =
    phase === "encrypting"
      ? "Building a real client-side FHE ciphertext and zero-knowledge input proof — typically takes 28-50 seconds on Sepolia."
      : phase === "buying"
        ? "Encrypted input built — waiting for buyCover() to be mined."
        : phase === "success"
          ? "Your policy is recorded on-chain for the current epoch."
          : undefined;

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            New Policy
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Buy Cover</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {(grantOperatorTxHash || buyCoverTxHash) && (
            <div className="space-y-2">
              {grantOperatorTxHash && (
                <TxConfirmationLink hash={grantOperatorTxHash} label="Operator access granted" />
              )}
              {buyCoverTxHash && (
                <TxConfirmationLink hash={buyCoverTxHash} label="Cover purchased" />
              )}
            </div>
          )}

          {hasOpenPolicy && policy ? (
            <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-4">
              <p className="font-mono text-xs text-foreground">
                You already have an open policy this round — <code>buyCover</code> is a
                one-time action per wallet for this pool (single-round, no renewal).
              </p>
              <p className="font-mono text-[11px] text-muted-foreground/70">
                Resubmitting won&apos;t add coverage — a repeat credit is a sticky
                no-op by design — but it will still pull a real premium from your{" "}
                {symbol} balance via <code>confidentialTransferFrom</code> for nothing.
              </p>
              <DataRow label="Epoch bought" value={policy[1].toString()} />
              <DataRow label="Claimed" value={policy[2] ? "Yes" : "No"} />
              <p className="font-mono text-[11px] text-muted-foreground/70">
                {policy[1] === currentEpoch
                  ? "Open policy — bought this epoch."
                  : "Open policy — carried forward from a prior epoch."}
              </p>
              <a
                href="#my-coverage"
                className="inline-block font-mono text-xs uppercase tracking-[0.14em] text-primary underline underline-offset-4"
              >
                View my coverage amount →
              </a>
            </div>
          ) : poolAcceptingNewCover === false ? (
            <div className="flex items-start gap-2 rounded-md border border-line/70 bg-card/40 p-4 font-mono text-xs text-muted-foreground">
              <ShieldX className="mt-0.5 size-3.5 shrink-0" />
              <span>
                This pool is no longer accepting new coverage — a claim window has already
                {status === "ClaimWindowOpen" ? " opened" : " closed"} for this round, and
                there&apos;s no path back to <code>Active</code> (§5). Buying cover now would
                just revert.
              </span>
            </div>
          ) : (
            <>
              {isOperator === false && (
                <div className="space-y-3">
                  <p className="font-mono text-xs text-muted-foreground">
                    The pool needs operator access on your {symbol} balance before it can
                    pull a premium via <code>confidentialTransferFrom</code>.
                  </p>
                  <Button
                    size="sm"
                    disabled={isBusy}
                    onClick={handleGrantOperator}
                  >
                    {phase === "granting-operator" ? "Granting…" : `Grant pool access to ${symbol}`}
                  </Button>
                </div>
              )}

              {isOperator === true && (
                <div className="space-y-3">
                  <label className="block font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    Coverage amount ({symbol})
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="100"
                    value={amount}
                    disabled={isBusy}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full rounded-md border border-line/70 bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  <Button
                    size="sm"
                    disabled={isBusy || !amount}
                    onClick={handleBuyCover}
                  >
                    {phase === "encrypting" || phase === "buying" ? "Working…" : "Buy cover"}
                  </Button>
                </div>
              )}
            </>
          )}

          {(phase === "encrypting" ||
            phase === "buying" ||
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
