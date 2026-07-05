"use client";

import { useState } from "react";
import { useAccount, useConfig, useReadContracts, useSignTypedData, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits, zeroAddress, zeroHash, type EIP1193Provider } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, Droplets, Eye, Unlock } from "lucide-react";
import { ABIS, CONTRACTS, REDOUBT_CHAIN } from "@/lib/contracts";
import { getFhevmInstance, userDecryptEuint64 } from "@/lib/fhevm";
import { CaseFileFrame } from "./case-file-frame";
import { TxConfirmationLink } from "./tx-confirmation-link";
import { OperationHud, type HudLogEntry } from "./crypto-process";

const underlyingContract = {
  address: CONTRACTS.underlyingToken,
  abi: ABIS.erc20Mock,
} as const;

// The wrapper (cUSDCMock) and the pool's premiumToken are the same deployed
// address -- this file just reads it through the wrapper-specific ABI
// (wrap/underlying/rate) instead of the narrower IERC7984 surface the other
// cards use against the same address.
const wrapperContract = {
  address: CONTRACTS.premiumToken,
  abi: ABIS.wrapper,
} as const;

type Phase = "idle" | "minting" | "approving" | "wrapping" | "signing" | "decrypting" | "error";

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function GetFundsCard() {
  const { address, connector, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [mintTxHash, setMintTxHash] = useState<`0x${string}`>();
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}`>();
  const [wrapTxHash, setWrapTxHash] = useState<`0x${string}`>();
  const [cleartextBalance, setCleartextBalance] = useState<bigint>();
  const [decryptLog, setDecryptLog] = useState<HudLogEntry[]>([]);

  const onCorrectNetwork = Boolean(address) && chainId === REDOUBT_CHAIN.id;

  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      { ...underlyingContract, functionName: "balanceOf", args: [address ?? zeroAddress] },
      { ...underlyingContract, functionName: "decimals" },
      { ...underlyingContract, functionName: "symbol" },
      {
        ...underlyingContract,
        functionName: "allowance",
        args: [address ?? zeroAddress, CONTRACTS.premiumToken],
      },
      { ...wrapperContract, functionName: "confidentialBalanceOf", args: [address ?? zeroAddress] },
      { ...wrapperContract, functionName: "symbol" },
    ],
    query: { enabled: onCorrectNetwork, refetchInterval: 15_000 },
  });

  const [balanceResult, decimalsResult, symbolResult, allowanceResult, wrapperBalanceResult, wrapperSymbolResult] =
    reads ?? [];
  const underlyingBalance = (balanceResult?.result as bigint | undefined) ?? BigInt(0);
  const decimals = (decimalsResult?.result as number | undefined) ?? 6;
  const symbol = (symbolResult?.result as string | undefined) ?? "USDCMock";
  const allowance = (allowanceResult?.result as bigint | undefined) ?? BigInt(0);
  const wrapperBalanceHandle = wrapperBalanceResult?.result as `0x${string}` | undefined;
  const wrapperSymbol = (wrapperSymbolResult?.result as string | undefined) ?? "cUSDCMock";

  // Same "never initialized" convention as the pool's own Policy.coverage
  // handle (session 8) -- confirmed against ERC7984.sol's confidentialBalanceOf,
  // which returns the zero-valued default handle for an account that never
  // received any confidential tokens. Never attempt to decrypt that.
  const hasWrapperBalance = wrapperBalanceHandle !== undefined && wrapperBalanceHandle !== zeroHash;

  const isBusy = phase !== "idle" && phase !== "error";

  let amountBaseUnits: bigint | undefined;
  try {
    amountBaseUnits = amount ? parseUnits(amount, decimals) : undefined;
  } catch {
    amountBaseUnits = undefined;
  }

  async function handleMint() {
    if (!address || !amountBaseUnits) return;
    setErrorMessage(undefined);
    setPhase("minting");
    try {
      const hash = await writeContractAsync({
        ...underlyingContract,
        functionName: "mint",
        args: [address, amountBaseUnits],
      });
      await waitForTransactionReceipt(config, { hash });
      setMintTxHash(hash);
      await refetchReads();
      setPhase("idle");
    } catch (e) {
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleWrap() {
    if (!address || !amountBaseUnits) return;
    setErrorMessage(undefined);
    try {
      if (allowance < amountBaseUnits) {
        setPhase("approving");
        const approveHash = await writeContractAsync({
          ...underlyingContract,
          functionName: "approve",
          args: [CONTRACTS.premiumToken, amountBaseUnits],
        });
        await waitForTransactionReceipt(config, { hash: approveHash });
        setApproveTxHash(approveHash);
        await refetchReads();
      }

      setPhase("wrapping");
      const wrapHash = await writeContractAsync({
        ...wrapperContract,
        functionName: "wrap",
        args: [address, amountBaseUnits],
      });
      await waitForTransactionReceipt(config, { hash: wrapHash });
      setWrapTxHash(wrapHash);
      await refetchReads();
      setPhase("idle");
    } catch (e) {
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  async function handleDecryptBalance() {
    if (!address || !connector || !wrapperBalanceHandle) return;
    setErrorMessage(undefined);
    const startedAt = Date.now();
    setPhase("signing");
    setDecryptLog([]);
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const instance = await getFhevmInstance(provider);
      const value = await userDecryptEuint64({
        instance,
        handle: wrapperBalanceHandle,
        contractAddress: CONTRACTS.premiumToken,
        userAddress: address,
        signTypedDataAsync,
        onPhase: (p) => {
          setPhase(p);
          setDecryptLog((prev) => [
            ...prev,
            {
              label: p === "signing" ? "Awaiting wallet signature" : "Verifying authorization + decrypting",
              atMs: Date.now() - startedAt,
            },
          ]);
        },
      });
      setCleartextBalance(value);
      setDecryptLog((prev) => [...prev, { label: "Balance decrypted", atMs: Date.now() - startedAt }]);
      setPhase("idle");
    } catch (e) {
      setDecryptLog((prev) => [...prev, { label: "Request failed", atMs: Date.now() - startedAt }]);
      setPhase("error");
      setErrorMessage(describeError(e));
    }
  }

  if (!address) {
    return (
      <CaseFileFrame>
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Connect a wallet to get test funds.
        </p>
      </CaseFileFrame>
    );
  }

  if (!onCorrectNetwork) return null;

  const needsApprove = amountBaseUnits !== undefined && allowance < amountBaseUnits;

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            Testnet Only
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Get Test Funds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {symbol} balance
              </p>
              <p className="font-heading text-xl font-semibold">
                {formatUnits(underlyingBalance, decimals)}
              </p>
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {wrapperSymbol} balance
              </p>
              {!hasWrapperBalance ? (
                <p className="font-heading text-xl font-semibold text-muted-foreground">—</p>
              ) : cleartextBalance === undefined ? (
                <Button size="sm" variant="outline" disabled={isBusy} onClick={handleDecryptBalance}>
                  <Unlock data-icon="inline-start" />
                  {isBusy && (phase === "signing" || phase === "decrypting") ? "Working…" : "Decrypt"}
                </Button>
              ) : (
                <p className="flex items-center gap-1.5 font-heading text-xl font-semibold text-primary">
                  <Eye className="size-4" />
                  {formatUnits(cleartextBalance, decimals)}
                </p>
              )}
            </div>
          </div>

          {(mintTxHash || approveTxHash || wrapTxHash) && (
            <div className="space-y-2">
              {mintTxHash && <TxConfirmationLink hash={mintTxHash} label={`Minted ${symbol}`} />}
              {approveTxHash && <TxConfirmationLink hash={approveTxHash} label="Wrapper approved" />}
              {wrapTxHash && <TxConfirmationLink hash={wrapTxHash} label={`Wrapped into ${wrapperSymbol}`} />}
            </div>
          )}

          <div className="space-y-3">
            <label className="block font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Amount ({symbol})
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
            <div className="flex flex-wrap gap-3">
              <Button size="sm" variant="outline" disabled={isBusy || !amountBaseUnits} onClick={handleMint}>
                <Droplets data-icon="inline-start" />
                {phase === "minting" ? "Minting…" : `1. Mint ${symbol}`}
              </Button>
              <Button size="sm" variant="outline" disabled={isBusy || !amountBaseUnits} onClick={handleWrap}>
                {phase === "approving"
                  ? "Approving…"
                  : phase === "wrapping"
                    ? "Wrapping…"
                    : needsApprove
                      ? `2. Approve + wrap → ${wrapperSymbol}`
                      : `2. Wrap → ${wrapperSymbol}`}
              </Button>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {symbol} is a permissionless testnet faucet token (max 1,000,000 per mint call).
              Wrapping converts it 1:1 into {wrapperSymbol}, the confidential token this pool's
              premium is paid in.
            </p>
          </div>

          {phase === "error" && (
            <OperationHud
              status="error"
              icon={Ban}
              log={decryptLog}
              errorMessage={errorMessage}
              onDismiss={() => {
                setPhase("idle");
                setErrorMessage(undefined);
              }}
            />
          )}

          {(phase === "signing" || phase === "decrypting") && (
            <OperationHud
              status="active"
              icon={Unlock}
              log={decryptLog}
              caption="Typically takes 3.7-5.0 seconds on Sepolia — slower than a public decrypt since the relayer also verifies your signed authorization."
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
