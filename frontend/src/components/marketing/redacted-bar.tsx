import { cn } from "@/lib/utils";

// A blacked-out line standing in for an encrypted value — the page's visual
// shorthand for "this number exists but is never shown in cleartext."
export function RedactedBar({
  width = "5rem",
  className,
}: {
  width?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-[0.8em] shrink-0 translate-y-[0.1em] rounded-[2px] bg-foreground/80",
        className
      )}
      style={{ width }}
    />
  );
}
