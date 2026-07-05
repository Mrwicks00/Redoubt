import { RevealSection } from "./reveal-section";
import { SolvencyDiagram } from "./solvency-diagram";
import { cn } from "@/lib/utils";

const PARTS = [
  {
    n: "01",
    title: "Blind underwriting",
    body: "buyCover() takes an encrypted coverage amount (externalEuint64 + a ZK proof of well-formedness). Premium is computed homomorphically: coverage × rateBps / 10_000 — division by a plaintext constant, which FHEVM supports. Ciphertext-to-ciphertext division is never used anywhere in this codebase.",
    diagram: false,
  },
  {
    n: "02",
    title: "Encrypted solvency proof",
    body: "The pool keeps a running encrypted sum of every policy's coverage. checkSolvency() does a single FHE.le(totalLiabilities, publicReserves) and requests decryption of only the resulting boolean — never any underlying amount.",
    diagram: true,
  },
  {
    n: "03",
    title: "Leakage-resistant claims",
    body: "Claims can only open after a public, undeniable oracle event — the price crossing a fixed depeg threshold. Payouts remain encrypted ERC-7984 transfers, settled per epoch rather than immediately per claim.",
    diagram: false,
  },
] as const;

export function MechanismSection() {
  return (
    <RevealSection className="border-b border-line/70 px-6 py-20 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
          The mechanism
        </p>
        <h2 className="mt-3 max-w-2xl font-heading text-3xl font-semibold sm:text-4xl">
          Three parts. This is the whole pitch.
        </h2>

        <div className="mt-10 space-y-10">
          {PARTS.map((part) => (
            <div
              key={part.n}
              className={cn(
                "grid gap-4 border-t border-line/60 pt-8 sm:grid-cols-[auto_1fr] sm:gap-8"
              )}
            >
              <div className="flex items-baseline gap-3 sm:flex-col sm:items-start sm:gap-1">
                <span className="font-mono text-3xl font-semibold text-primary/70">
                  {part.n}
                </span>
              </div>
              <div>
                <h3 className="font-heading text-xl font-semibold sm:text-2xl">
                  {part.title}
                </h3>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
                  {part.body}
                </p>
                {part.diagram && (
                  <div className="mt-6">
                    <SolvencyDiagram />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </RevealSection>
  );
}
