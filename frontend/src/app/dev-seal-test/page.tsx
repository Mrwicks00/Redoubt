"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { OperationHud, type HudLogEntry } from "@/components/redoubt/crypto-process";

const LOGS: HudLogEntry[] = [
  { label: "Encrypting value client-side", atMs: 0 },
  { label: "Generating zero-knowledge proof", atMs: 4000 },
  { label: "Packaging encrypted input", atMs: 9000 },
];

export default function DevSealTest() {
  const [idx, setIdx] = useState(2);
  return (
    <div className="min-h-screen bg-background p-8">
      <button
        className="fixed top-2 left-2 z-[60] rounded bg-white px-2 py-1 text-black"
        onClick={() => setIdx((i) => (i + 1) % LOGS.length)}
      >
        cycle ({idx})
      </button>
      <OperationHud
        status="active"
        icon={Lock}
        log={LOGS.slice(0, idx + 1)}
        caption="Building a real client-side FHE ciphertext and zero-knowledge input proof — typically takes 28-50 seconds on Sepolia."
        onDismiss={() => {}}
      />
    </div>
  );
}
