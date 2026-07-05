import { cn } from "@/lib/utils";

export function DataRow({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 border-b border-line/60 py-3 last:border-b-0",
        className
      )}
    >
      <span className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm text-foreground">{value}</span>
    </div>
  );
}
