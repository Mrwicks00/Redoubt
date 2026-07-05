import { RevealSection } from "./reveal-section";
import { cn } from "@/lib/utils";

const ROWS = [
  {
    event: "buyCover",
    visible: "that an address bought cover, in which epoch",
    hidden: "coverage amount, premium amount",
    risk: "timing correlation if very few buyers in an epoch",
    unsolved: false,
  },
  {
    event: "settleEpoch",
    visible: "epoch's total premiums once decrypted",
    hidden: "each buyer's individual premium",
    risk: "thin epochs — mitigated by the MIN_EPOCH_PARTICIPANTS guard below",
    unsolved: false,
  },
  {
    event: "checkSolvency",
    visible: "one bit: solvent true/false",
    hidden: "total liabilities, reserve composition",
    risk: "repeated solvency checks bracketing one buy/claim transaction can narrow that user's amount via the reserve delta",
    unsolved: true,
  },
  {
    event: "claim",
    visible: "that an address claimed",
    hidden: "payout amount (still ERC-7984 encrypted)",
    risk: "claim timing correlates with the known public depeg time; mitigated by batched claim windows",
    unsolved: false,
  },
] as const;

export function LeakageTableSection() {
  return (
    <RevealSection className="border-b border-line/70 px-6 py-20 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
          Leakage model
        </p>
        <h2 className="mt-3 max-w-2xl font-heading text-3xl font-semibold sm:text-4xl">
          Filed, not hidden.
        </h2>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          This is not a fully private system. Every event below reveals
          something to an outside observer — a project that documents its own
          known limitation next to its guarantees is more credible, not less.
        </p>

        <div className="mt-8 overflow-x-auto rounded-lg border border-line/70">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line/70 bg-card/60">
                {["Event", "Visible", "Hidden", "Residual risk"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr
                  key={row.event}
                  className={cn(
                    "border-b border-line/60 align-top last:border-b-0",
                    row.unsolved && "bg-destructive/[0.06]"
                  )}
                >
                  <td className="px-4 py-4 font-mono text-xs font-medium whitespace-nowrap text-foreground">
                    {row.event}
                  </td>
                  <td className="px-4 py-4 text-muted-foreground">
                    {row.visible}
                  </td>
                  <td className="px-4 py-4 text-muted-foreground">
                    {row.hidden}
                  </td>
                  <td className="px-4 py-4">
                    {row.unsolved && (
                      <span
                        className="mb-1.5 inline-flex -rotate-1 items-center rounded-sm border-2 border-destructive px-2 py-0.5 font-heading text-[10px] font-semibold uppercase tracking-[0.14em] text-destructive"
                        style={{ borderStyle: "double", borderWidth: "3px" }}
                      >
                        Unsolved
                      </span>
                    )}
                    <p
                      className={cn(
                        "text-muted-foreground",
                        row.unsolved && "text-destructive/90"
                      )}
                    >
                      {row.risk}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Guard implemented:</span>{" "}
            MIN_EPOCH_PARTICIPANTS (3) withholds premium decryption entirely if
            fewer than 3 policies were bought in an epoch — the pending amount
            rolls into the next epoch instead of settling. An aggregate of one
            or two participants isn&apos;t an aggregate, it&apos;s a leak with
            extra steps.
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-destructive">
              Known open problem:
            </span>{" "}
            repeated checkSolvency calls immediately before/after a single
            buyCover let an observer bracket that buyer&apos;s coverage via
            the reserve delta. Candidate mitigations, in rough order of cost:
            rate-limit checkSolvency to once per epoch; require N intervening
            transactions between checks; add synthetic noise to
            publicReserves reporting. A genuine open design problem, not a
            bug — a discussion point, not something to hide.
          </p>
        </div>
      </div>
    </RevealSection>
  );
}
