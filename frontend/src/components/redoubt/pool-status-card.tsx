"use client";

import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";
import { ABIS, CONTRACTS, POOL_STATUS } from "@/lib/contracts";
import { TIMING_TIER } from "@/lib/timing";
import { StatusStamp } from "./status-stamp";
import { DataRow } from "./data-row";
import { CaseFileFrame } from "./case-file-frame";

const poolContract = {
  address: CONTRACTS.redoubtCoverPool,
  abi: ABIS.redoubtCoverPool,
} as const;

const tokenContract = {
  address: CONTRACTS.premiumToken,
  abi: ABIS.ierc7984,
} as const;

export function PoolStatusCard() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useReadContracts({
    contracts: [
      { ...poolContract, functionName: "status" },
      { ...poolContract, functionName: "currentEpoch" },
      { ...poolContract, functionName: "publicReserves" },
      { ...tokenContract, functionName: "decimals" },
      { ...tokenContract, functionName: "symbol" },
    ],
    query: {
      refetchInterval: 15_000,
    },
  });

  if (isError) {
    return (
      <CaseFileFrame>
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
          <CircleAlert data-icon="inline-start" />
          <AlertTitle className="font-mono">READ FAILED</AlertTitle>
          <AlertDescription>
            {error?.message ?? "Could not reach the pool contract."}
          </AlertDescription>
        </Alert>
      </CaseFileFrame>
    );
  }

  if (isLoading || !data) {
    return (
      <CaseFileFrame>
        <div className="space-y-4">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
            {TIMING_TIER.read.label}…
          </p>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </CaseFileFrame>
    );
  }

  const [statusResult, epochResult, reservesResult, decimalsResult, symbolResult] = data;

  const statusIndex = statusResult.result as number | undefined;
  const status = POOL_STATUS[statusIndex ?? 0];
  const currentEpoch = epochResult.result as bigint | undefined;
  const publicReserves = reservesResult.result as bigint | undefined;
  const decimals = (decimalsResult.result as number | undefined) ?? 6;
  const symbol = (symbolResult.result as string | undefined) ?? "cUSDCMock";

  const reservesFormatted =
    publicReserves !== undefined ? formatUnits(publicReserves, decimals) : "—";

  return (
    <CaseFileFrame>
      <Card className="border-line/70 bg-transparent shadow-none">
        <CardHeader className="gap-1">
          <CardDescription className="font-mono text-xs uppercase tracking-[0.18em]">
            File No. {CONTRACTS.redoubtCoverPool.slice(0, 10)}…
            {CONTRACTS.redoubtCoverPool.slice(-4)}
          </CardDescription>
          <CardTitle className="font-heading text-2xl font-semibold">
            RedoubtCoverPool
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <StatusStamp status={status} />

          <div>
            <DataRow label="Current epoch" value={currentEpoch?.toString() ?? "—"} />
            <DataRow
              label="Public reserves"
              value={`${reservesFormatted} ${symbol}`}
            />
            <DataRow
              label="Premium token"
              value={
                <span title={CONTRACTS.premiumToken}>
                  {CONTRACTS.premiumToken.slice(0, 6)}…
                  {CONTRACTS.premiumToken.slice(-4)}
                </span>
              }
            />
          </div>

          <p className="font-mono text-[11px] text-muted-foreground/70">
            Last read {new Date(dataUpdatedAt).toLocaleTimeString()} · plain
            public reads only, no decryption involved
          </p>
        </CardContent>
      </Card>
    </CaseFileFrame>
  );
}
