"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { REDOUBT_CHAIN } from "@/lib/contracts";
import { TriangleAlert } from "lucide-react";

export function NetworkGate() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === REDOUBT_CHAIN.id) return null;

  return (
    <Alert variant="destructive" className="border-destructive/40 bg-destructive/10">
      <TriangleAlert data-icon="inline-start" />
      <AlertTitle className="font-mono tracking-wide">
        ACCESS DENIED — WRONG NETWORK
      </AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>
          This case file only opens on {REDOUBT_CHAIN.name}. Your wallet is on
          chain {chainId}.
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => switchChain({ chainId: REDOUBT_CHAIN.id })}
        >
          {isPending ? "Switching…" : `Switch to ${REDOUBT_CHAIN.name}`}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
