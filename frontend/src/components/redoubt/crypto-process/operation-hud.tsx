"use client";

import { useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatElapsed } from "./format-elapsed";
import { DecoderText } from "./decoder-text";
import { usePrefersReducedMotion } from "./use-reduced-motion";

export type HudLogEntry = {
  label: string;
  atMs: number;
};

export type HudStatus = "active" | "success" | "error";

const RING_TONE: Record<HudStatus, string> = {
  active: "border-primary/70 text-primary",
  success: "border-primary text-primary",
  error: "border-destructive text-destructive",
};

// Success clears itself -- this is a status readout, not a decision the
// user needs to act on. Errors don't auto-dismiss: the message stays until
// the user closes it or starts a new attempt, since they need time to read it.
const SUCCESS_AUTO_DISMISS_MS = 4000;

// A floating circular ops badge, centered over the whole viewport -- not a
// panel inside the card. It pops onto the screen the moment a real async
// chain starts (buyCover's encrypt->submit->confirm, or decrypt's
// sign->verify) and stays there through every real phase transition until
// success or error. The ring only spins and the label only decodes while
// `status === "active"`; both lock solid the instant the real promise chain
// resolves either way, so nothing here implies progress that isn't actually
// happening.
export function OperationHud({
  status,
  icon: Icon,
  log,
  caption,
  errorMessage,
  onDismiss,
}: {
  status: HudStatus;
  icon: LucideIcon;
  log: HudLogEntry[];
  caption?: string;
  errorMessage?: string;
  onDismiss: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const current = log.at(-1);
  const spinning = status === "active" && !reducedMotion;

  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (status !== "success") return;
    const id = setTimeout(() => onDismissRef.current(), SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [status]);

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="pointer-events-auto animate-in fade-in-0 zoom-in-50 flex flex-col items-center gap-2 duration-300">
        <div
          className={cn(
            "relative flex size-32 items-center justify-center rounded-full border-2 bg-card/95 shadow-xl shadow-black/40 backdrop-blur-sm",
            RING_TONE[status]
          )}
        >
          {spinning && (
            <span
              aria-hidden
              className="absolute inset-0 animate-spin rounded-full [animation-duration:1.6s]"
              style={{
                background:
                  "conic-gradient(from 0deg, transparent 0deg, var(--primary) 55deg, transparent 105deg)",
                WebkitMaskImage:
                  "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
                maskImage:
                  "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
              }}
            />
          )}

          <div className="flex flex-col items-center gap-1.5 px-4 text-center">
            <Icon
              key={current?.label}
              className={cn(
                "animate-in zoom-in-50 fade-in-0 relative size-6 duration-200",
                RING_TONE[status]
              )}
            />
            <span
              className={cn(
                "font-mono text-[9px] uppercase leading-tight tracking-wide",
                RING_TONE[status]
              )}
            >
              <DecoderText key={current?.label} text={current?.label ?? ""} active={spinning} />
            </span>
          </div>

          {status !== "active" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="absolute -top-1 -right-1 flex size-6 items-center justify-center rounded-full border border-line/70 bg-card text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-col items-center gap-1">
          {current && (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {formatElapsed(current.atMs)}
            </span>
          )}
          {status === "error" && errorMessage && (
            <p className="max-w-64 text-center font-mono text-[10px] text-destructive/90">
              {errorMessage}
            </p>
          )}
          {caption && status !== "error" && (
            <p className="max-w-64 text-center font-mono text-[10px] text-muted-foreground/60">
              {caption}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
