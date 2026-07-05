import Link from "next/link";
import { Button } from "@/components/ui/button";
import { REDOUBT_CHAIN } from "@/lib/contracts";

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-line/70 bg-background/90 px-6 py-4 backdrop-blur sm:px-10">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <div>
          <p className="font-heading text-lg font-semibold tracking-tight">
            Redoubt
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Confidential cover pool · {REDOUBT_CHAIN.name}
          </p>
        </div>
        <Button
          render={<Link href="/app" />}
          nativeButton={false}
          size="sm"
          variant="outline"
        >
          Open pool status
        </Button>
      </div>
    </header>
  );
}
