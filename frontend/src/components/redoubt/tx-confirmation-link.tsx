"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { REDOUBT_CHAIN } from "@/lib/contracts";

// Persistent record of a confirmed on-chain action -- unlike the OperationHud
// (which auto-dismisses), this stays on screen so the user always has a way
// to verify what happened on-chain from inside the app itself.
export function TxConfirmationLink({
  hash,
  label,
}: {
  hash: `0x${string}`;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const explorerUrl = `${REDOUBT_CHAIN.blockExplorers?.default.url}/tx/${hash}`;

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line/70 bg-card/40 px-3 py-2">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 font-mono text-xs text-foreground hover:text-primary"
          aria-label="Copy transaction hash"
        >
          {hash.slice(0, 8)}…{hash.slice(-6)}
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 font-mono text-xs uppercase tracking-[0.1em] text-primary underline underline-offset-4"
        >
          Etherscan <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}
