"use client";

import { ProviderNotFoundError, useAccount, useConnect, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
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

  // Single button for both desktop and mobile: try the browser extension
  // (injected) first, since ProviderNotFoundError is exactly how it
  // reports "no extension installed" -- no window.ethereum sniffing
  // needed. On a plain mobile browser that throws, so fall back to
  // walletConnect(), which deep-links into a wallet app instead.
  const handleConnect = async () => {
    const injectedConnector = connectors.find((c) => c.type === "injected");
    const walletConnectConnector = connectors.find((c) => c.type === "walletConnect");
    try {
      if (injectedConnector) {
        await connectAsync({ connector: injectedConnector });
        return;
      }
    } catch (error) {
      if (!(error instanceof ProviderNotFoundError)) throw error;
    }
    if (walletConnectConnector) {
      await connectAsync({ connector: walletConnectConnector });
    }
  };

  return (
    <Button size="sm" disabled={isPending} onClick={handleConnect}>
      {isPending ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}
