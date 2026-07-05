import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RevealSection } from "./reveal-section";
import { cn } from "@/lib/utils";

const CASES = [
  {
    label: "A ZK proof",
    verdict: "INSUFFICIENT",
    verdictClass: "border-status-claim text-status-claim",
    body: "Proves a fact about one person's own input. It cannot prove an aggregate fact — “the sum of everyone's coverage fits in reserves” — without someone first collecting all the plaintext inputs.",
  },
  {
    label: "A trusted server",
    verdict: "REJECTED",
    verdictClass: "border-destructive text-destructive",
    body: "Could compute the aggregate, but only by seeing everyone's coverage in the clear. That recreates the exact surveillance problem this protocol exists to solve — a $2M depeg-cover purchase reveals a $2M position in that asset.",
  },
  {
    label: "FHE (Redoubt)",
    verdict: "IN USE",
    verdictClass: "border-status-active text-status-active",
    body: "Computes the joint fact over encrypted inputs. checkSolvency() compares encrypted total liabilities against public reserves and decrypts only the result: one bit, solvent true or false.",
  },
] as const;

export function WhyFheSection() {
  return (
    <RevealSection className="border-b border-line/70 px-6 py-20 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
          The question every judge asks first
        </p>
        <h2 className="mt-3 max-w-2xl font-heading text-3xl font-semibold sm:text-4xl">
          Why FHE — not ZK, and not a trusted server.
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Solvency is a joint computation over every policyholder&apos;s
          secret. Three ways to attempt it, and why only one avoids leaking
          the thing the pool is supposed to protect.
        </p>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {CASES.map((c) => (
            <Card key={c.label} className="border border-line/70 bg-card/60 shadow-none">
              <CardHeader className="gap-3">
                <span
                  className={cn(
                    "inline-flex w-fit -rotate-1 items-center rounded-sm border-2 px-2.5 py-0.5 font-heading text-[11px] font-semibold uppercase tracking-[0.14em]",
                    c.verdictClass
                  )}
                  style={{ borderStyle: "double", borderWidth: "4px" }}
                >
                  {c.verdict}
                </span>
                <CardTitle className="text-lg">{c.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{c.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="mt-10 max-w-2xl border-l-2 border-primary/60 pl-4 font-heading text-lg text-foreground/90">
          FHE isn&apos;t used here because it&apos;s novel. It&apos;s used
          because the alternative — plaintext coverage amounts — is a direct
          information leak with no mitigation.
        </p>
      </div>
    </RevealSection>
  );
}
