import { cn } from "@/lib/utils";

const CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "bottom-0 right-0 border-b-2 border-r-2",
] as const;

// Bastion-corner brackets — a redoubt is defined by its fortified corners,
// so the frame around the pool's case file literally draws them.
export function CaseFileFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative p-6 sm:p-8", className)}>
      {CORNERS.map((corner) => (
        <span
          key={corner}
          aria-hidden
          className={cn("absolute size-4 border-primary/70", corner)}
        />
      ))}
      {children}
    </div>
  );
}
