import { cn } from "@/lib/utils";
import type { PoolStatusLabel } from "@/lib/contracts";

const STAMP_COPY: Record<PoolStatusLabel, string> = {
  Active: "Active",
  ClaimWindowOpen: "Claim Window Open",
  Settled: "Settled",
};

const STAMP_COLOR: Record<PoolStatusLabel, string> = {
  Active: "border-status-active text-status-active",
  ClaimWindowOpen: "border-status-claim text-status-claim",
  Settled: "border-status-settled text-status-settled",
};

export function StatusStamp({ status }: { status: PoolStatusLabel }) {
  return (
    <div
      className={cn(
        "inline-flex -rotate-2 items-center gap-2 rounded-sm border-2 px-4 py-1.5",
        "font-heading text-lg font-semibold uppercase tracking-wide",
        "before:content-[''] after:content-['']",
        STAMP_COLOR[status]
      )}
      style={{ borderStyle: "double", borderWidth: "4px" }}
    >
      {STAMP_COPY[status]}
    </div>
  );
}
