"use client";

import { useState } from "react";
import { useConfig, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Ban, TriangleAlert } from "lucide-react";
import { ABIS, CONTRACTS } from "@/lib/contracts";
import { CaseFileFrame } from "../case-file-frame";
import { DataRow } from "../data-row";
import { TxConfirmationLink } from "../tx-confirmation-link";
import { useNowSeconds } from "./use-now-seconds";
import { formatDuration } from "./format-time";

const oracleContract = {
  address: CONTRACTS.mockPriceOracle,
  abi: ABIS.mockPriceOracle,
} as const;

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

// Prices are 1e8 fixed point throughout this contract (§9/§4) -- e.g.
// 100_000_000 == 1.00. formatUnits/parseUnits with 8 decimals round-trips
// exactly the same way pool-status-card.tsx already does for the premium
// token's own decimals.
const PRICE_DECIMALS = 8;

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

// The one card on this page where the owner gate mirrors a REAL on-chain
// restriction: MockPriceOracle.setPrice reverts for anyone but its owner.
// Every other admin card is permissionless on-chain (see owner-gate.tsx).
export function OraclePriceCard() {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [newPrice, setNewPrice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [txHash, setTxHash] = useState<`0x${string}`>();

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...oracleContract, functionName: "latestPrice" },
      { ...oracleContract, functionName: "lastUpdated" },
      { ...poolContract, functionName: "depegThreshold" },
      { ...poolContract, functionName: "maxOracleStaleness" },
    ],
    query: { refetchInterval: 15_000 },
  });

  const [priceResult, lastUpdatedResult, thresholdResult, staleResult] = reads ?? [];
  const latestPrice = priceResult?.result as bigint | undefined;
  const lastUpdated = lastUpdatedResult?.result as bigint | undefined;
  const depegThreshold = thresholdResult?.result as bigint | undefined;
  const maxOracleStaleness = staleResult?.result as bigint | undefined;

  const nowSec = useNowSeconds();
  const oracleAge = nowSec !== undefined && lastUpdated !== undefined ? nowSec - lastUpdated : undefined;
  const isStale =
    oracleAge !== undefined && maxOracleStaleness !== undefined
      ? oracleAge > maxOracleStaleness
      : undefined;
  const belowThreshold =
    latestPrice !== undefined && depegThreshold !== undefined
      ? latestPrice < depegThreshold
      : undefined;

  async function handleSetPrice() {
    if (!newPrice) return;
    setErrorMessage(undefined);
    setIsSubmitting(true);
    try {
      const parsed = parseUnits(newPrice, PRICE_DECIMALS);
      const hash = await writeContractAsync({
        ...oracleContract,
        functionName: "setPrice",
        args: [parsed],
      });
      await waitForTransactionReceipt(config, { hash });
      setTxHash(hash);
      setNewPrice("");
      await refetch();
    } catch (e) {
      setErrorMessage(describeError(e));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            MockPriceOracle · owner-gated on-chain
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">Oracle Price</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="font-mono text-[11px] text-muted-foreground/70">
            This is the only action on this page actually enforced by a contract-level
            owner check — <code>setPrice</code> reverts for any other caller. Everything
            else below is a permissionless pool function grouped here for convenience.
          </p>

          <div>
            <DataRow
              label="Latest price"
              value={latestPrice !== undefined ? formatUnits(latestPrice, PRICE_DECIMALS) : "—"}
            />
            <DataRow
              label="Depeg threshold"
              value={depegThreshold !== undefined ? formatUnits(depegThreshold, PRICE_DECIMALS) : "—"}
            />
            <DataRow
              label="Below threshold?"
              value={belowThreshold === undefined ? "—" : belowThreshold ? "Yes" : "No"}
            />
            <DataRow
              label="Oracle age"
              value={oracleAge !== undefined ? formatDuration(oracleAge) : "—"}
            />
            <DataRow
              label="Max staleness tolerated"
              value={maxOracleStaleness !== undefined ? formatDuration(maxOracleStaleness) : "—"}
            />
          </div>

          {isStale && (
            <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
              <TriangleAlert data-icon="inline-start" />
              <AlertTitle className="font-mono">STALE</AlertTitle>
              <AlertDescription>
                Oracle age exceeds <code>maxOracleStaleness</code> — <code>triggerClaimWindow</code>{" "}
                would revert against this price right now.
              </AlertDescription>
            </Alert>
          )}

          {txHash && <TxConfirmationLink hash={txHash} label="Price updated" />}

          {errorMessage && (
            <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
              <Ban data-icon="inline-start" />
              <AlertTitle className="font-mono">FAILED</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            <label className="block font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
              New price (1e8 fixed point, e.g. 0.94 for a 6% depeg)
            </label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="1.00"
              value={newPrice}
              disabled={isSubmitting}
              onChange={(e) => setNewPrice(e.target.value)}
              className="w-full rounded-md border border-line/70 bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <Button size="sm" disabled={isSubmitting || !newPrice} onClick={handleSetPrice}>
              {isSubmitting ? "Submitting…" : "Set price"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
