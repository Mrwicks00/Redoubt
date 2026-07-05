import { RevealSection } from "./reveal-section";
import { cn } from "@/lib/utils";

const LEADS = [
  {
    name: "Netting batcher",
    verdict: "REJECTED",
    verdictClass: "border-destructive text-destructive",
    note: "MEV-blind order aggregation — privacy guarantee is ~zero below 10 concurrent participants, and it competes against free incumbents. Its core lesson still shapes Redoubt directly: no public event should correspond to exactly one person's secret.",
  },
  {
    name: "Confidential lending",
    verdict: "RUNNER-UP",
    verdictClass: "border-status-claim text-status-claim",
    note: "The other finalist. Passed over only because Redoubt has a cleaner why-FHE-not-ZK argument and an empty competitive lane — confidential lending is where the ecosystem's own commercial activity is already headed.",
  },
  {
    name: "Order book / dark triggers",
    verdict: "SHELVED",
    verdictClass: "border-status-settled text-status-settled",
    note: "Scoped in the original brainstorm but not pursued — prior art already exists. Dark triggers is architecturally close to Redoubt's claim trigger; revisit if a second peril type is ever needed.",
  },
] as const;

export function AlternativesStrip() {
  return (
    <RevealSection className="border-b border-line/70 px-6 py-16 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
          Case log
        </p>
        <h2 className="mt-3 max-w-2xl font-heading text-2xl font-semibold sm:text-3xl">
          Other leads, and why they were closed.
        </h2>

        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {LEADS.map((lead) => (
            <div
              key={lead.name}
              className="rounded-lg border border-line/70 bg-card/40 p-5"
            >
              <span
                className={cn(
                  "inline-flex -rotate-1 items-center rounded-sm border-2 px-2 py-0.5 font-heading text-[10px] font-semibold uppercase tracking-[0.14em]",
                  lead.verdictClass
                )}
                style={{ borderStyle: "double", borderWidth: "3px" }}
              >
                {lead.verdict}
              </span>
              <p className="mt-3 font-heading text-base font-semibold">
                {lead.name}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {lead.note}
              </p>
            </div>
          ))}
        </div>
      </div>
    </RevealSection>
  );
}
