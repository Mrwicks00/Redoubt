import { useEffect, useState } from "react";

// Every admin card compares an on-chain deadline (epoch end, decryptionTimeout
// eligibility, claim-window close) against "now." Calling Date.now() directly
// in a component body trips this project's react-hooks/purity lint rule
// (render must be idempotent) -- same category of gotcha as session 12's
// react-hooks/refs finding in CLAUDE.md. Ticks via a plain interval instead,
// mirroring buy-cover-card.tsx's own elapsedMs pattern; undefined until the
// first effect tick fires (never valid to read before mount, unlike a
// render-time Date.now() call).
export function useNowSeconds(intervalMs = 1_000): bigint | undefined {
  const [now, setNow] = useState<bigint>();

  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
