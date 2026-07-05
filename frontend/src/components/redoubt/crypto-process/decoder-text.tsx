"use client";

import { useEffect, useState } from "react";

// Cryptic machine-symbol set -- hex digits and math/logic glyphs, not any
// real-world script, so the "decoding" scramble reads as cipher noise, never
// as a mockery of an actual language.
const GLYPHS = "01#$%&*+=<>≠≈∆∑◇◆▚▞".split("");

function scrambledExcept(target: string, revealCount: number) {
  return target
    .split("")
    .map((ch, i) =>
      i < revealCount || ch === " " || ch === "…"
        ? ch
        : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    )
    .join("");
}

// A cipher resolving into plaintext, left to right, rather than text just
// swapping instantly. Retriggers by remounting -- pass `key={text}` at the
// call site -- rather than resetting state from an effect keyed on `text`,
// so the only setState call here happens inside the interval's own tick
// callback (react-hooks/set-state-in-effect wants external-system updates
// applied from a subscription callback, not synchronously in the effect body).
export function DecoderText({ text, active }: { text: string; active: boolean }) {
  const [display, setDisplay] = useState(() => (active ? scrambledExcept(text, 0) : text));

  useEffect(() => {
    if (!active || !text) return;
    let revealCount = 0;
    const id = setInterval(() => {
      revealCount += 1;
      setDisplay(scrambledExcept(text, revealCount));
      if (revealCount >= text.length) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
    // Mount-only by design: retriggering happens via the `key={text}` remount
    // at the call site, not by re-running this effect on prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{display}</>;
}
