"use client";

import { useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "@/components/ui/button";
import { CaseFileFrame } from "@/components/redoubt/case-file-frame";
import { DataRow } from "@/components/redoubt/data-row";
import { RedactedBar } from "./redacted-bar";
import { CONTRACTS, REDOUBT_CHAIN } from "@/lib/contracts";

gsap.registerPlugin(useGSAP);

const etherscanUrl = `${REDOUBT_CHAIN.blockExplorers?.default.url}/address/${CONTRACTS.redoubtCoverPool}`;

export function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from(".hero-eyebrow", { autoAlpha: 0, y: 10, duration: 0.5 })
          .from(
            ".hero-line",
            { autoAlpha: 0, y: 22, duration: 0.7, stagger: 0.12 },
            "-=0.25"
          )
          .from(".hero-sub", { autoAlpha: 0, y: 14, duration: 0.6 }, "-=0.35")
          .from(
            ".hero-cta",
            { autoAlpha: 0, y: 10, duration: 0.5, stagger: 0.08 },
            "-=0.35"
          )
          .from(
            ".hero-file",
            { autoAlpha: 0, y: 18, scale: 0.98, duration: 0.7 },
            "-=0.5"
          )
          .from(
            ".hero-redacted",
            { scaleX: 0, transformOrigin: "left center", duration: 0.4, stagger: 0.08 },
            "-=0.3"
          );
      });
      return () => mm.revert();
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden border-b border-line/70 px-6 py-20 sm:px-10 sm:py-28"
    >
      <div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div>
          <p className="hero-eyebrow font-mono text-xs uppercase tracking-[0.22em] text-primary">
            Confidential cover pool · FHEVM · {REDOUBT_CHAIN.name}
          </p>
          <h1 className="mt-4 font-heading text-4xl font-semibold leading-[1.08] sm:text-5xl lg:text-[3.4rem]">
            <span className="hero-line block">
              A pool that proves it can pay every claim —
            </span>
            <span className="hero-line block text-muted-foreground">
              without revealing what anyone is owed.
            </span>
          </h1>
          <p className="hero-sub mt-6 max-w-xl text-base text-muted-foreground sm:text-lg">
            Coverage amounts, premiums, and payouts are encrypted end to end
            on Zama&apos;s FHEVM (ERC-7984 + <code className="font-mono">euint64</code>).
            Solvency is proven by comparing encrypted total liabilities
            against public reserves — never the amounts themselves.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button
              render={<Link href="/app" />}
              nativeButton={false}
              size="lg"
              className="hero-cta"
            >
              Open pool status
            </Button>
            <Button
              render={
                <a href={etherscanUrl} target="_blank" rel="noreferrer" />
              }
              nativeButton={false}
              size="lg"
              variant="outline"
              className="hero-cta"
            >
              View contract on Etherscan
            </Button>
          </div>
        </div>

        <div className="hero-file">
          <CaseFileFrame className="border border-line/70 bg-card/60">
            <div className="mb-5 flex items-start justify-between gap-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                File No. {CONTRACTS.redoubtCoverPool.slice(0, 10)}…
                {CONTRACTS.redoubtCoverPool.slice(-4)}
              </p>
              <span
                className="-rotate-2 whitespace-nowrap border-destructive px-2.5 py-1 font-heading text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive"
                style={{ borderStyle: "double", borderWidth: "4px" }}
              >
                Confidential
              </span>
            </div>
            <p className="mb-5 font-heading text-xl font-semibold">
              RedoubtCoverPool
            </p>
            <div className="space-y-0">
              <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-3">
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Coverage
                </span>
                <RedactedBar
                  width="4.5rem"
                  className="hero-redacted"
                />
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-3">
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Premium
                </span>
                <RedactedBar
                  width="3.25rem"
                  className="hero-redacted"
                />
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-3">
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Payout
                </span>
                <RedactedBar
                  width="4rem"
                  className="hero-redacted"
                />
              </div>
              <DataRow label="Pool status" value="Public" className="border-b-0" />
            </div>
          </CaseFileFrame>
        </div>
      </div>
    </section>
  );
}
