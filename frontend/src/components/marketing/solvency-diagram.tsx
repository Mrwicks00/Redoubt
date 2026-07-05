"use client";

import { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RedactedBar } from "./redacted-bar";

gsap.registerPlugin(useGSAP);

const POLICIES = ["A", "B", "C"] as const;

// The single clearest illustration of what FHE does here: encrypted values
// go in, exactly one public bit comes out. Built as its own animated
// component (not a static diagram) so a judge can trigger it and watch the
// encrypted amounts stay hidden while only the boolean surfaces — the whole
// argument of §3/§4 made physical rather than asserted in prose.
export function SolvencyDiagram() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasRun, setHasRun] = useState(false);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  const { contextSafe } = useGSAP(
    () => {
      gsap.set(".solv-caption", { autoAlpha: 0, y: 8 });

      const tl = gsap.timeline({
        paused: true,
        defaults: { ease: "power2.inOut" },
      });

      tl.to(".solv-input", {
        autoAlpha: 0.15,
        duration: 0.35,
        stagger: 0.05,
      })
        .fromTo(
          ".solv-seal",
          { scale: 1 },
          { scale: 1.1, duration: 0.22, yoyo: true, repeat: 1 },
          "-=0.05"
        )
        .set(".solv-stamp", { display: "inline-flex" })
        .fromTo(
          ".solv-stamp",
          { autoAlpha: 0, scale: 0.6, rotate: 8 },
          {
            autoAlpha: 1,
            scale: 1,
            rotate: -4,
            duration: 0.55,
            ease: "back.out(1.8)",
          }
        )
        .to(
          ".solv-caption",
          { autoAlpha: 1, y: 0, duration: 0.4 },
          "-=0.2"
        );

      tlRef.current = tl;
    },
    { scope: containerRef }
  );

  // contextSafe defers execution to the click handler it returns; the ref
  // read never happens during render. react-hooks/refs can't see through
  // that indirection, so it flags this as if the read were synchronous.
  // eslint-disable-next-line react-hooks/refs
  const run = contextSafe(() => {
    setHasRun(true);
    tlRef.current?.restart();
  });

  return (
    <div ref={containerRef} className="rounded-lg border border-line/70 bg-background/40 p-5 sm:p-7">
      <div className="grid gap-6 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        {/* Encrypted inputs */}
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <Lock className="size-3" /> Encrypted — never shown
          </p>
          {POLICIES.map((p) => (
            <div
              key={p}
              className="solv-input flex items-baseline justify-between gap-4 border-b border-line/50 pb-2"
            >
              <span className="font-mono text-xs text-muted-foreground">
                Policy {p} coverage
              </span>
              <RedactedBar width="3.5rem" />
            </div>
          ))}
          <div className="solv-input flex items-baseline justify-between gap-4 pt-1">
            <span className="font-mono text-xs font-medium text-foreground">
              totalLiabilities
            </span>
            <RedactedBar width="4.5rem" className="bg-primary/80" />
          </div>
        </div>

        {/* Operation */}
        <div className="flex flex-col items-center gap-3 justify-self-center">
          <div className="solv-seal flex size-16 items-center justify-center rounded-full border-2 border-primary/70 bg-card font-mono text-[9px] leading-tight text-primary">
            FHE.le(
            <br />
            …)
          </div>
          <Button size="sm" onClick={run}>
            {hasRun ? "Run again" : "Run checkSolvency()"}
          </Button>
        </div>

        {/* Output */}
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <Unlock className="size-3" /> Public, always
          </p>
          <div className="flex items-baseline justify-between gap-4 border-b border-line/50 pb-2">
            <span className="font-mono text-xs text-muted-foreground">
              publicReserves
            </span>
            <span className="font-mono text-xs text-foreground">
              visible on-chain
            </span>
          </div>
          <div className="flex min-h-11 items-center pt-1">
            <span
              className="solv-stamp hidden items-center rounded-sm border-2 border-status-settled px-3 py-1 font-heading text-sm font-semibold uppercase tracking-wide text-status-settled"
              style={{ borderStyle: "double", borderWidth: "4px" }}
            >
              solvent: false
            </span>
          </div>
        </div>
      </div>

      <p className="solv-caption mt-6 max-w-2xl text-xs text-muted-foreground">
        This is a real result from a live Sepolia run: 3
        policies, 300 USDC total liabilities vs. 15 USDC reserves after one
        epoch → <span className="text-foreground">solvent: false</span>{" "}
        (expected for a single-epoch demo with no extra funding, not a bug).
        The liability total and reserve composition were never decrypted —
        only this one boolean crossed the wire in cleartext.
      </p>
    </div>
  );
}
