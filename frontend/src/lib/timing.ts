// Real Sepolia timing measured in CLAUDE_HISTORY.md Session 10 — not
// estimates. The two FHE-relayer operations are NOT symmetric, so no
// loading state in this app should treat them as interchangeable "loading…"
// spinners once encrypted flows exist:
//
//  - encrypted INPUT creation (createEncryptedInput(...).encrypt(), needed
//    before every buyCover-style call): ~28-50s per call.
//  - public DECRYPTION of an already-decryptable handle (publicDecrypt(...),
//    needed by every finalize* call): a consistent ~3.3-3.6s.
//
// This session only reads plain public contract state (status/epoch/
// reserves), which resolves at ordinary RPC speed (well under a second) —
// none of the tiers below are exercised yet. They're defined now so the
// buyCover/decrypt sessions that follow reuse one shared vocabulary instead
// of every future loading spinner inventing its own guess.
// Session 19 measured a fourth, genuinely distinct operation:
// instance.userDecrypt(...) (the EIP-712 user-decrypt path, as opposed to
// publicDecrypt's no-signature public reveal). Four real Sepolia calls came
// back at 4549ms/4952ms/3837ms/3707ms -- consistently above the `decrypt`
// tier's 3.3-3.6s range, not the same number just because both are
// "decryption": userDecrypt's relayer round trip carries an extra
// authorization check against the caller's EIP-712 signature that
// publicDecrypt's request never does. Deliberately its own tier rather than
// folded into `decrypt`. Separate from this: the time a real browser wallet
// takes for a human to approve the EIP-712 signature itself is NOT included
// in these numbers (this session signed with a raw private key, no human
// prompt) and has no fixed estimate -- the UI must show that as its own
// indeterminate step, not lump it into userDecrypt's estimate.
export const TIMING_TIER = {
  read: { label: "Reading chain state", estimateMs: 1_000 },
  decrypt: { label: "Awaiting public decryption", estimateMs: 3_500 },
  encryptedInput: { label: "Encrypting input client-side", estimateMs: 39_000 },
  userDecrypt: { label: "Requesting authorized decryption", estimateMs: 4_300 },
} as const;

export type TimingTierKey = keyof typeof TIMING_TIER;
