"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContracts, useSignTypedData } from "wagmi";
import { formatUnits, zeroHash, type EIP1193Provider } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, CircleAlert, Eye, Lock, Unlock } from "lucide-react";
import { ABIS, CONTRACTS, REDOUBT_CHAIN } from "@/lib/contracts";
import { getFhevmInstance, userDecryptEuint64 } from "@/lib/fhevm";
import { CaseFileFrame } from "./case-file-frame";
import { DataRow } from "./data-row";
import { OperationHud, type HudLogEntry } from "./crypto-process";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

const tokenContract = {
  address: CONTRACTS.premiumToken,
  abi: ABIS.ierc7984,
} as const;

type Phase = "idle" | "signing" | "decrypting" | "success" | "error";

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function MyCoverageCard() {
  const { address, connector, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [cleartextCoverage, setCleartextCoverage] = useState<bigint>();
  const [log, setLog] = useState<HudLogEntry[]>([]);

  const onCorrectNetwork = Boolean(address) && chainId === REDOUBT_CHAIN.id;

  const { data: reads } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "policies", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...tokenContract, functionName: "decimals" },
      { ...tokenContract, functionName: "symbol" },
    ],
    query: { enabled: onCorrectNetwork },
  });

  const [policyResult, decimalsResult, symbolResult] = reads ?? [];
  const policy = policyResult?.result as readonly [`0x${string}`, bigint, boolean] | undefined;
  const decimals = (decimalsResult?.result as number | undefined) ?? 6;
  const symbol = (symbolResult?.result as string | undefined) ?? "cUSDCMock";

  // Session 8's FHE.isInitialized distinction, read here off the plain public
  // getter rather than a decrypt: a zero handle means no Policy was ever
  // written for this address -- NOT "coverage is zero". Never attempt to
  // decrypt a handle that was never initialized.
  const coverageHandle = policy?.[0];
  const hasPolicy = coverageHandle !== undefined && coverageHandle !== zeroHash;

  // Resets all local UI state when the connected address or the on-chain
  // handle changes underneath it -- the React-recommended alternative is a
  // `key` on this component from its parent, but that's a page-composition
  // change outside this session's scope. Pre-existing pattern (session 19),
  // not introduced here; suppressed rather than restructured for now.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase("idle");
    setErrorMessage(undefined);
    setCleartextCoverage(undefined);
    setLog([]);
  }, [address, coverageHandle]);

  async function handleDecrypt() {
    if (!address || !connector || !coverageHandle) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setPhase("signing");
    setLog([]);
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const instance = await getFhevmInstance(provider);

      // Human wallet-approval time lives entirely inside the "signing" phase
      // below -- no fixed estimate, deliberately shown as its own
      // indeterminate step rather than folded into userDecrypt's timed
      // estimate. See lib/fhevm.ts's userDecryptEuint64 for the EIP-712
      // construction + bigint-coercion details (session 19 finding,
      // extracted into a shared helper session 21 for reuse against a
      // second ciphertext in get-funds-card.tsx).
      const value = await userDecryptEuint64({
        instance,
        handle: coverageHandle,
        contractAddress: CONTRACTS.redoubtCoverPool,
        userAddress: address,
        signTypedDataAsync,
        onPhase: (phase) => {
          setPhase(phase);
          setLog((prev) => [
            ...prev,
            {
              label:
                phase === "signing"
                  ? "Awaiting wallet signature"
                  : "Verifying authorization + decrypting",
              atMs: Date.now() - startedAt,
            },
          ]);
        },
      });

      setCleartextCoverage(value);
      setLog((prev) => [
        ...prev,
        { label: "Coverage decrypted", atMs: Date.now() - startedAt },
      ]);
      setPhase("success");
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
          Connect a wallet to view your coverage.
        </p>
      </CaseFileFrame>
    );
  }

  if (!onCorrectNetwork) return null;

  const isBusy = phase === "signing" || phase === "decrypting";

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Your Policy
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">My Coverage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {!hasPolicy && (
            <p className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              This wallet has no open policy on RedoubtCoverPool. Buy cover first.
            </p>
          )}

          {hasPolicy && policy && (
            <>
              <DataRow label="Epoch bought" value={policy[1].toString()} />
              <DataRow label="Claimed" value={policy[2] ? "Yes" : "No"} />

              {cleartextCoverage === undefined ? (
                <div className="space-y-3">
                  <p className="font-mono text-xs text-muted-foreground">
                    Your coverage amount is encrypted on-chain. Decrypting it requires
                    signing an EIP-712 authorization with this wallet -- only you can
                    reveal this value.
                  </p>
                  <Button size="sm" disabled={isBusy} onClick={handleDecrypt}>
                    <Lock data-icon="inline-start" />
                    {isBusy ? "Working…" : "Decrypt my coverage"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-4">
                  <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-primary">
                    <Eye className="size-3.5" />
                    Visible only to this wallet
                  </div>
                  <p className="font-heading text-3xl font-semibold">
                    {formatUnits(cleartextCoverage, decimals)} {symbol}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground/70">
                    Unlike the pool&apos;s public reserves figure above, this number
                    is not visible to anyone else -- it was decrypted client-side for
                    your address only, via a signed EIP-712 authorization.
                  </p>
                </div>
              )}
            </>
          )}

          {(phase === "signing" || phase === "decrypting" || phase === "error") && (
            <OperationHud
              status={phase === "error" ? "error" : "active"}
              icon={phase === "error" ? Ban : phase === "signing" ? Lock : Unlock}
              log={log}
              caption={
                phase === "signing"
                  ? "Approve the EIP-712 decrypt authorization in your wallet — this step has no fixed duration."
                  : phase === "decrypting"
                    ? "Typically takes 3.7-5.0 seconds on Sepolia — slower than a public decrypt since the relayer also verifies your signed authorization."
                    : undefined
              }
              errorMessage={
                phase === "error" && errorMessage
                  ? `${errorMessage} If this wallet doesn't hold the policy being decrypted, the relayer will reject the request — this is expected, not a bug.`
                  : undefined
              }
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
