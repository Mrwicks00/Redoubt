"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {shortenAddress(address)}
        </span>
        <Button variant="outline" size="sm" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  const injectedConnector = connectors[0];

  return (
    <Button
      size="sm"
      disabled={!injectedConnector || isPending}
      onClick={() => injectedConnector && connect({ connector: injectedConnector })}
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}
