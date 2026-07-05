# CLAUDE.md — Redoubt

Confidential cover pools on Zama FHEVM. This file is the full context dump
for building this project from scratch in Claude Code. **No code exists
yet.** Read this entire file before writing anything — the design
decisions here came out of a long scoping conversation and encode reasons,
not just requirements. Do not silently re-derive or "improve" on them
without flagging it to the user first.

---

## 0. Current state (sessions 1-9 complete — see CLAUDE_HISTORY.md for full reasoning)

**Built and passing:** `buyCover`; the four-stage pipeline
`settleEpoch()` → `finalizeParticipantCount()` → `finalizePremiumValueCheck()`
→ `finalizePremiumSettlement()` (session 15 inserted the third stage);
`checkSolvency()` → `finalizeSolvencyCheck()`; `triggerClaimWindow()` →
`settleClaimWindow()`; `claim()` → `finalizeClaim()`. Session 16 added three
permissionless escape-hatch functions — `abandonStuckSettlement()`,
`abandonStuckSolvencyCheck()`, `abandonStuckClaim(holder)` — for a
decryption stuck past `decryptionTimeout`, plus `ReentrancyGuard` exploit
tests, a `settleEpoch()`/`ClaimWindowOpen` interaction test, and
`maxOracleStaleness` converted from a hardcoded constant to a constructor
param.
`IPriceOracle`/`MockPriceOracle` written per §9.
`test/RedoubtCoverPool.t.sol`: 43/43 tests green (44/44 incl. skeleton) —
see session 16 below for the eleven newest.

**Session 9 — the path to `Settled`:** added `claimWindowDuration`
(immutable, constructor param like `epochLength`) and `claimWindowOpenedAt`
(set once in `triggerClaimWindow`). New permissionless `settleClaimWindow()`
flips `ClaimWindowOpen` → `Settled` once `claimWindowDuration` has elapsed,
mirroring `settleEpoch()`'s relationship to `epochLength` — reaching the
deadline doesn't auto-transition, an explicit call is still required, same
as every other phase change here. Emits `ClaimEpochSettled(epoch)`
(§9's previously-unspecified event, now defined). Rejected an admin
"close now" function (no admin role exists anywhere else in this
contract) and "close once everyone's claimed" (encrypted population,
one non-claiming holder would wedge the pool forever) in favor of the
fixed-duration approach. Critically: `finalizeClaim()` has **no status
gate** at all — a `claim()` already in flight when the window closes
still resolves normally after `Settled`; only *new* `claim()` calls are
cut off (they already required `ClaimWindowOpen`). Verified this is
load-bearing, not incidental, by temporarily gating `finalizeClaim` on
`ClaimWindowOpen` and confirming the new in-flight test fails.

**Session 10 — Sepolia deployment, full manual flow confirmed end to end
on real FHEVM infrastructure (no code changes to `RedoubtCoverPool.sol`
this session):**

- **Deployed contracts (Sepolia):** `MockPriceOracle` at
  `0x233db038721156a154890842783ED9c372242f33`; `RedoubtCoverPool` at
  `0xF20a2bb9C47d98E2e22cEe6e8E824f88D6DbC584` (both verified on
  Etherscan). Constructor params: `premiumRateBps=500` (5%),
  `epochLength=300s`, `claimWindowDuration=300s`, `depegThreshold=95_000_000`
  (1e8 fixed point, 5% below an assumed 1.00 peg), initial oracle price
  `100_000_000`. The 5-minute epoch/claim-window lengths are
  **demo-scale, not a production recommendation** — chosen deliberately
  short so this session could observe real on-chain deadlines elapsing
  in wall-clock time (no `vm.warp` on a live chain); §9's own example
  used day-scale lengths.
- **premiumToken path taken: real registry pair, not a fabricated
  address, not a self-deployed token.** Found Zama's Confidential Token
  Wrappers Registry live on Sepolia at
  `0x2f0750Bbb0A246059d80e94c454586a7F27a128e` and independently
  verified it on-chain (bytecode inspection, live
  `getTokenConfidentialTokenPairsSlice()` call returning 9 real pairs,
  `isConfidentialTokenValid()`) rather than trusting a documentation
  fetch on faith — a first WebFetch attempt at a manipulated doc URL
  handed back a plausible-looking but unverified address, which was
  correctly treated as suspect and independently confirmed on-chain
  before use rather than accepted. Used the registered pair: underlying
  `USDCMock` (`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`, 6 decimals,
  permissionless `mint`) wrapped as `cUSDCMock`
  (`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`, real
  `IERC7984ERC20Wrapper`, `isConfidentialTokenValid() == true`).
- **Full manual flow confirmed working end to end on real Sepolia
  infrastructure:** `buyCover` (3 real wallets, real
  `@zama-fhe/relayer-sdk` encrypted input + real KMS input-proof) →
  `settleEpoch` → `finalizeParticipantCount` (count=3, cleared
  `MIN_EPOCH_PARTICIPANTS`) → `finalizePremiumSettlement` (revealed
  total 15,000,000 = 3×5 USDC premium) → `checkSolvency` →
  `finalizeSolvencyCheck` (correctly `solvent=false`: 300 USDC total
  liabilities vs. 15 USDC reserves after one epoch — expected given the
  demo's single-epoch, no-extra-funding setup, not a bug) →
  `triggerClaimWindow` → `claim` ×3 → `finalizeClaim` ×3 (correctly
  `fullyPaid=false` for all three — pool under-funded relative to
  liabilities, exactly the failure mode `confidentialTransfer`'s
  no-revert/no-partial-pay design is supposed to produce; policies
  remain unclaimed and retriable) → `settleClaimWindow` (pool reached
  `Settled`). Every pending-guard, every ACL grant, and the
  `abi.encodePacked(cleartexts)` KMS-signing format all behaved
  identically to forge-fhevm's local mock — **no divergence found in
  FHEVM host-contract behavior beyond timing.**
- **Real KMS/relayer timing observed (§12's predicted risk, now
  measured):** building an encrypted input client-side and getting back
  a real KMS input-proof (`instance.createEncryptedInput(...).encrypt()`)
  took **~28–50 seconds** per call — this is the slow, user-facing step,
  incurred once per `buyCover`, before any on-chain tx is even sent.
  By contrast, **public decryption** of an already-`makePubliclyDecryptable`
  handle (`instance.publicDecrypt(...)`, used by every `finalize*`
  function) was consistently fast, **~3.3–3.6 seconds**, across all 6
  calls (participant count, premium total, solvency bool, 3× claim
  bool). One-time `createInstance()` setup (public key + CRS fetch) took
  ~10s. None of this is instant like local forge-fhevm, but none of it
  broke any pending-guard either — real latency was well under any
  guard's assumptions. **Frontend implication:** a `buyCover` UI needs a
  real "encrypting… (~30-50s)" loading state; a `finalize*` UI's wait is
  much shorter (~3-4s).
- **Environment note, not a protocol finding:** intermittent
  `@zama-fhe/relayer-sdk` connection failures during this session
  (`fetch failed` / `Bad JSON`) were traced to this sandbox's broken
  IPv6 egress to the relayer's Cloudflare endpoint — Node's `fetch`
  tries IPv6 first by default and hangs, while `curl` did not exhibit
  the problem. Fixed with `NODE_OPTIONS=--dns-result-order=ipv4first`;
  zero retries needed afterward. Not a Zama relayer reliability issue —
  logged so a future session doesn't misdiagnose the same symptom as
  real-world relayer flakiness.
- Node.js compatibility: `@zama-fhe/relayer-sdk@0.4.4` declares
  `engines.node >= 22`; this session ran it successfully on Node 20.19.4
  (via the `/node` CJS subpath export) with only an `EBADENGINE`
  warning, no functional failure — worth re-checking on a Node 22+
  environment for a production frontend rather than assuming this always
  works.
- Helper scripts live in `contract/relayer-scripts/` (gitignored
  `node_modules`, own `package.json`): `01_setup_and_buy.js` through
  `05_settle_claim_window.js`, plus `client.js`/`config.js`. Not part of
  the Foundry project — a scratch harness for this session's manual
  verification, not a frontend.

**Genuinely still open (session 15 mitigated both, neither is fully
solved — see session 15 writeup below and §6 for exactly what each fix
does and does not cover):**
- §6's "repeated `checkSolvency` brackets a buyer's amount" leakage
  problem — **mitigated, not solved.** `checkSolvency()` is now rate-limited
  to once per `currentEpoch` (see session 15). A single buyCover can no
  longer be bracketed by two solvency checks in the same epoch. A patient
  attacker checking once per epoch over many epochs, watching the reserve
  delta trend, can still attempt slower, noisier inference — harder and
  slower now, not impossible.
- Sybil-identity gap: many distinct real addresses each paying a tiny
  amount can still legitimately pad `epochParticipantCount` — headcount
  padding itself is untouched by session 15. What session 15 added is a
  companion value-based guard (`minEpochPremiumTotal`): an epoch also
  withholds if the padded epoch's real total premium value is too low, so
  cheap/dust padding no longer works even if headcount clears
  `MIN_EPOCH_PARTICIPANTS`. **Does not stop** a well-funded attacker padding
  headcount with several moderately-sized real payments instead — that
  still clears both guards. Session 8 closed the free-attempt/paid-repeat
  padding attacks; this is a third, narrower gap closed on top, not a
  general fix for sybil headcount padding itself.
- Frontend: wallet connect, network gate, read-only pool status (session
  11), marketing page (session 12), Sepolia redeploy rewiring (session 17),
  a real `buyCover` flow with client-side FHE encryption (session 18), the
  EIP-712 user-decrypt flow for a policyholder's own coverage (session 19),
  a test-funds mint/wrap/decrypt flow (session 21), a `claim()` UI
  (session 22), and a gated `/admin` page for pool-lifecycle actions
  (session 23) are done. Sessions 19-21 landed without a §15 writeup at the
  time — see §15's session 22 entry for the catch-up and its caveats.
  Genuinely still open, user-facing: nothing from the core buyCover → view
  coverage → claim loop, and nothing from the pool-lifecycle/admin surface
  either as of session 23 — see §15's session 23 entry for exactly what's
  built and its verification gaps.
- **Moral hazard, session 13 — distinct from the §6 leakage items above,
  this is an economic gap, not a privacy leak:** `buyCover` never checks
  whether the caller actually holds the coin they're insuring, and a fix
  was investigated and found architecturally blocked, not just
  unbuilt. Session 14 built a partial mitigation (minimum holding period
  — see below); the core "never held the coin at all" case remains open.
  Full writeup below.

**Load-bearing lessons — do not rediscover these:**
- `FHE.requestDecryption` + callback does **not exist** in
  `@fhevm/solidity` 0.11.1. The real pattern is pull-model:
  `FHE.makePubliclyDecryptable(handle)` → off-chain KMS proof →
  permissionless `FHE.checkSignatures(...)` in a separate finalize call.
  Every flow here is at least two transactions, never one — the epoch
  settlement pipeline is four as of session 15 (`settleEpoch` →
  `finalizeParticipantCount` → `finalizePremiumValueCheck` →
  `finalizePremiumSettlement`), one per value that needs its own
  withhold-or-reveal decision before the next thing becomes decryptable.
- KMS proofs sign `abi.encodePacked(cleartexts)`, **not** `abi.encode` —
  forge-fhevm's own testing-patterns.md example is wrong on this point.
- FHE ops auto-grant only *transient*, same-contract, same-tx ACL
  access. Persistent access, or access for a *different* contract,
  always needs an explicit `FHE.allowThis`/`FHE.allow`.
- `confidentialTransfer` has no `isOperator` check (moves the caller's
  own balance); `confidentialTransferFrom` does. Never assume one
  mirrors the other — verify against `ERC7984.sol` directly.
- `confidentialBalanceOf(account)` is a plain view getter — it performs
  no FHE op and calls `FHE.allow` on nothing. The handle it returns
  carries ACL access **only** for the token contract itself and for
  `account`, never for whatever third-party contract called
  `confidentialBalanceOf`. And that third party cannot self-remedy this
  with its own `FHE.allow` call: `ACL.allow()` requires the caller
  already be allowed on the handle, so a not-yet-allowed contract can't
  grant itself access. Any design that reads another party's balance via
  `confidentialBalanceOf` and expects to use it in a same-tx FHE
  comparison (e.g. `FHE.le`) will revert with `SenderNotAllowed` — this
  is a structural ACL wall, not a missing grant to add.
- No ciphertext/ciphertext division, ever (§7) — `FHE.div`/`FHE.rem`
  only accept plaintext divisors.
- Real KMS/relayer timing is asymmetric, not uniformly "slow": encrypted
  *input* creation (`createEncryptedInput(...).encrypt()`, needed before
  every call like `buyCover`) took ~28-50s on Sepolia; *public decryption*
  of an already-decryptable handle (`publicDecrypt(...)`, needed by every
  `finalize*`) took a consistent ~3.3-3.6s. Don't assume both are equally
  slow when budgeting UX/timeouts.
- `@zama-fhe/relayer-sdk` on Node can fail with confusing `fetch failed`/
  `Bad JSON` errors that look like relayer flakiness but are actually
  Node's IPv6-first DNS resolution hitting a broken IPv6 path — try
  `NODE_OPTIONS=--dns-result-order=ipv4first` before concluding the
  relayer itself is unreliable.

**Session 13 — moral-hazard gap in `buyCover`, investigated, found
architecturally blocked, built nothing (no `RedoubtCoverPool.sol`
changes this session):**

- **The problem.** `buyCover` has no way to verify the caller actually
  holds the coin they're insuring. Coverage can be bought as a pure bet
  on a depeg rather than genuine loss protection — e.g. zero real
  `premiumToken` holdings, buy max coverage, collect full payout on
  trigger. This is a different category from every §6 leakage item:
  those are about encrypted information escaping; this is a missing
  economic constraint. Nothing encrypted leaks here — the flaw is that
  the contract doesn't check a real-world fact it easily could, in
  principle.
- **The technical wall (confirmed, not guessed).** The obvious fix —
  `FHE.le(coverage, premiumToken.confidentialBalanceOf(msg.sender))`,
  folded into `shouldCredit` alongside `fullyPaid`/`alreadyCovered` — is
  not implementable. `confidentialBalanceOf` (`ERC7984.sol:100-102`) is
  a plain view getter, no FHE op, no `FHE.allow` call at all; the only
  ACL grants ever placed on a balance handle happen in `_update`
  (`ERC7984.sol:275-309`), and only to the token contract itself and the
  balance owner — never a third-party contract like this pool. Worse,
  the pool can't self-remedy: `ACL.allow()` (`ACL.sol:186-196`) requires
  the caller *already* be allowed on the handle before it can extend
  access, so `FHE.allow(holderBalance, address(this))` from inside the
  pool reverts for the same reason the comparison itself would have.
  Checked the full `IERC7984`/`IERC7984ERC20Wrapper` surface for any
  scoped third-party-grant method — there is none. Net: this comparison
  reverts with `SenderNotAllowed` on every call, a structural property of
  ERC7984's ACL model as written, not a missing line of code. (Also
  logged as a load-bearing lesson above.)
- **Reframing, not just a gap.** Given this wall, Redoubt is — and for
  v1 should be described as — a **parametric insurance design**: payout
  triggers on a public, objective fact (the oracle crossing
  `depegThreshold`), with no proof-of-loss step. This is the same
  deliberate trade real-world crop insurance and catastrophe bonds make
  — speed and simplicity over individually verifying each claimant's
  actual loss. State this as an intentional category in the README/pitch
  alongside §6's leakage table, not as an oversight being quietly worked
  around.
- **Built, session 14 — waiting period between `buyCover` and claim
  eligibility.** `MIN_HOLDING_EPOCHS = 1` (constant); `claim()` now
  requires `currentEpoch >= policies[msg.sender].epochBought +
  MIN_HOLDING_EPOCHS`, i.e. coverage bought in epoch N is only
  claim-eligible from epoch N+1 onward. Checked **per-policy** against
  that policy's own `epochBought`, inside `claim()` itself — deliberately
  NOT a pool-wide gate on `triggerClaimWindow` or `status`: a depeg
  triggered soon after one buyer's purchase must only block that buyer's
  claim, not every existing policyholder's claim just because someone
  else bought recently. `triggerClaimWindow` stays untouched — it only
  answers "is there a real, public depeg," a question with no
  relationship to any individual buyer's timing. Safe against being
  gamed shorter: `epochBought` is (re-)set to `currentEpoch` on every
  `buyCover` call (including a harmless redundant one after a buyer is
  already fully covered), but `currentEpoch` only ever moves forward, so
  this can only push a holder's own eligibility later, never earlier —
  not exploitable, and the only downside is self-inflicted (an
  already-covered buyer calling `buyCover` again resets their own clock).
  **State precisely what this does and does not fix:** this closes only
  the sharpest version of the moral-hazard gap — buying cover in the
  last few minutes before a *known* depeg on insider knowledge. It does
  **not** close the general "never held the coin at all" case (§13's
  core finding): someone can still buy cover with zero real exposure,
  wait out one epoch, and collect a payout if they're eventually right
  about a depeg with no time pressure to act on inside information. Two
  new tests: `test_claim_revertsWhenBoughtInCurrentEpoch` (cover bought
  the same epoch a depeg triggers is rejected) and
  `test_claim_succeedsWhenBoughtEpochsBeforeClaimWindow` (cover bought
  and then aged one epoch before the depeg claims normally). Verified the
  rejection test actually catches a regression, not just passing
  trivially, by temporarily replacing the new `require`'s condition with
  `true` and confirming the test failed, then reverting. Five pre-existing
  claim tests that bought cover and claimed within the same epoch (no
  `settleEpoch()` call in between) needed a `_advanceEpoch()` test helper
  added before their claim to keep passing under the new gate — a
  required update given the new invariant, not a silent behavior change.
  *Coverage cap relative to `premiumToken`'s total real supply* remains
  considered but not built (still needs a separate public supply source
  since `confidentialTotalSupply()` is itself encrypted) — a future
  session's item, not this one.
- **Deeper future direction, explicitly not attempted here.** Bridging
  FHE ciphertexts with a ZK proof (proving "my real balance ≥ X" without
  decrypting it, without needing pool-side ACL access at all) is an open
  research problem in this ecosystem, not an available toolchain item —
  named here as a real forward-looking direction, not a corner cut.
- **Escrow/collateral-lock considered and rejected as a different,
  wrong product**, not a workaround: pulling `coverage` into pool
  custody via a second `confidentialTransferFrom` (the only fix that
  *is* ACL-legal, since the pool already has transient access to
  `coverage` from computing it) would require every buyer to lock 100%
  of their coverage amount as collateral. If you already have the funds
  to lock, you don't need coverage for them — this isn't insurance
  anymore, it's self-collateralized escrow, and it would also convert
  Redoubt from pooled/fractional-reserve insurance (session 10's own
  300 USDC liabilities vs. 15 USDC reserves is the *intended* shape of
  this design) into something else entirely. Rejected without building.

**Session 15 — mitigations for both of §0's remaining genuinely-open
leakage problems. Read as real hardening of the cheap/easy version of
each attack, NOT as either problem being fully solved — both residual
gaps are stated plainly below and in §6:**

- **`checkSolvency` bracketing, rate-limited to once per epoch.** New
  `lastSolvencyCheckEpoch` (set to `currentEpoch` the moment
  `checkSolvency()` is INITIATED, not when it finalizes); `checkSolvency()`
  now requires `currentEpoch != lastSolvencyCheckEpoch` IN ADDITION to the
  pre-existing `!solvencyCheckPending` guard — two independent gates
  ("too soon since the last one" vs. "one already in flight"), both must
  hold, neither replaces the other (confirmed with a dedicated test:
  calling again immediately, decryption still pending, hits the
  `pending` revert first, not the epoch one). Chosen "once per
  `currentEpoch`," not "once per `epochLength` time window," because
  `currentEpoch` is the exact clock every other epoch-gated check in this
  contract already reads (`buyCover`'s `epochBought`, `claim`'s holding-
  period check, the settlement pipeline's `pendingSettlementEpoch`) — a
  parallel `block.timestamp`-based cooldown would be a second, independent
  time system that could drift out of step with it, strictly worse to
  reason about alongside existing logic. **What this closes:** a single
  `buyCover` can no longer be sandwiched between two solvency checks
  within the same epoch — every other buyer's activity in that epoch now
  falls between any two allowed checks. **What this does NOT close:** an
  attacker checking once at the start and once at the end of every epoch,
  over many epochs, watching the reserve delta trend over time, could
  still attempt slower, noisier inference — harder and slower now, not
  impossible. Two new tests
  (`test_checkSolvency_revertsOnSecondCallInSameEpoch`,
  `test_checkSolvency_succeedsInLaterEpoch`), plus a third
  (`test_checkSolvency_revertsWhilePendingEvenInSameEpoch`) proving the two
  gates are independent. Verified load-bearing by temporarily commenting
  out the new `require` and confirming
  `test_checkSolvency_revertsOnSecondCallInSameEpoch` failed, then
  restoring.
- **Thin-value sybil padding, mitigated with a `minEpochPremiumTotal`
  value threshold alongside the existing `MIN_EPOCH_PARTICIPANTS`
  headcount threshold.** Unlike `MIN_EPOCH_PARTICIPANTS` (a pure
  headcount, dimensionless across any deployment), a meaningful minimum
  VALUE is inherently token/market-specific — same reasoning that already
  makes `depegThreshold` a constructor param rather than a hardcoded
  constant. So `minEpochPremiumTotal` is an immutable constructor param
  (camelCase, deliberately not ALL_CAPS like the true protocol constants),
  not a `uint256 public constant`. Test suite value: `10_000` (existing
  3-buyer "sufficient participants" fixture totals `30_000`, comfortably
  clears it; a 3-buyer dust-padding fixture totals `3`, comfortably fails
  it). Deploy script value: `5_000_000` (5 USDC in cUSDCMock's 6 decimals,
  sized off session 10's own real demo numbers — a genuine small demo
  still clears it, a few cents of sybil dust across 3 addresses does not).
  **Pipeline restructuring, not a bolt-on check:** the premium total is
  only ever decrypted in `finalizePremiumSettlement`, which runs AFTER
  `finalizeParticipantCount` has already decided to proceed — so
  checking `minEpochPremiumTotal` by decrypting the real total first and
  withholding after the fact would already be too late.
  `makePubliclyDecryptable` plus a submitted KMS proof reveals the real
  number to anyone off-chain the moment it happens, regardless of what the
  contract does with it afterward — the identical ordering trap session 8
  had to solve for participant-count-vs-total (see settleEpoch's own
  comment, and CLAUDE_HISTORY.md's session 8 entry). The fix: inserted a
  new intermediate stage. `finalizeParticipantCount`, once the count
  clears `MIN_EPOCH_PARTICIPANTS`, now computes `valueOk =
  FHE.ge(premiumsAwaitingDecryption, minEpochPremiumTotal-as-euint64)` — a
  still-encrypted comparison that reveals nothing — and marks only THAT
  BIT decryptable (new `finalizePremiumValueCheck` function), mirroring
  `checkSolvency`'s own one-bit-reveal shape. Only once that bit resolves
  `true` does `finalizePremiumValueCheck` mark the real premium total
  decryptable at all, handing off to the unchanged
  `finalizePremiumSettlement`. The pipeline is four stages now, not three:
  `settleEpoch` → `finalizeParticipantCount` → `finalizePremiumValueCheck`
  → `finalizePremiumSettlement`. `settleEpoch`'s pending-guard gained a
  third condition (`!premiumValueCheckPending`) alongside the existing
  two, for the same reason the other two exist: a second `settleEpoch()`
  must not be able to overwrite the in-flight snapshot handles while ANY
  stage of the previous pipeline is unresolved. A below-threshold-value
  epoch withholds via the exact same roll-forward mechanism session 8
  already built for the count-fail branch (both accumulators added back
  into the live totals, nothing lost, nothing revealed) — reuses the
  `PremiumEpochWithheld` event since the guarantee to callers is identical
  either way ("this epoch's total was not revealed"). **What this does:**
  raises the cost of padding with many tiny/dust payments specifically.
  **What this does NOT do:** does not stop a well-funded attacker from
  padding headcount with several moderately-sized REAL payments instead —
  that still clears both `MIN_EPOCH_PARTICIPANTS` and
  `minEpochPremiumTotal`. Headcount-only sybil padding (the general "many
  distinct real addresses" gap) remains open. Two new tests
  (`test_finalizePremiumValueCheck_withholdsWhenTotalBelowThreshold`,
  and the updated `test_settleEpoch_settlesWithSufficientParticipants` now
  asserting the value-check stage explicitly). Verified load-bearing by
  temporarily bypassing the `FHE.ge` check (going straight to
  `premiumDecryptionPending = true` as pre-session-15 code did) and
  confirming `test_finalizePremiumValueCheck_withholdsWhenTotalBelowThreshold`
  failed (the low-value/high-headcount epoch would have wrongly settled),
  then restoring.
- **Constructor signature changed** (all three existing call sites
  updated — `test/RedoubtCoverPool.t.sol`'s two pool constructions,
  `script/DeployRedoubtCoverPool.s.sol`): added trailing
  `minEpochPremiumTotal_` param. Full suite re-run green after the change:
  32/32 (33/33 incl. skeleton).

**Session 16 — worked §11's hardening checklist item by item. First
finding: items 1-3 were already sitting in the tree, undocumented, from
an interrupted or unrecorded prior pass — audited each before trusting
any of it, rather than assuming "present" meant "correct" or "complete":**

- **Discovery, not a starting-from-scratch session.**
  `RedoubtCoverPool.sol` already had `ReentrancyGuard`/`nonReentrant` on
  `buyCover`/`claim`, a `require(status == PoolStatus.Active, ...)` at
  the top of `settleEpoch()`, and a full stale-oracle check
  (`IPriceOracle.lastUpdated()`, `MockPriceOracle`, a
  `MAX_ORACLE_STALENESS` constant, and a passing
  `test_triggerClaimWindow_revertsWhenOraclePriceStale` test) — none of
  it mentioned anywhere in this file's §0 or §11, and no
  CLAUDE_HISTORY.md entry for it. Test count matched session 15's
  documented "32/32" exactly, meaning this had landed silently alongside
  or after session 15 without a doc update. Treated as real progress to
  build on, not redone from scratch, per the user's explicit instruction
  after being asked — but every piece was independently audited against
  this session's actual requirements before being accepted, and two real
  gaps were found in the "already done" parts: `MAX_ORACLE_STALENESS`
  was a hardcoded constant (item 3 wants a constructor param, matching
  `depegThreshold`/`minEpochPremiumTotal`'s convention), and neither the
  `settleEpoch`/`ClaimWindowOpen` interaction nor the reentrancy guards
  had a dedicated test proving they actually do what they claim.

- **Item 1 — `settleEpoch()`/`ClaimWindowOpen` (small).** The existing
  `require(status == PoolStatus.Active, ...)` was already correct:
  traced the interaction with `finalizeParticipantCount`/
  `finalizePremiumValueCheck`/`finalizePremiumSettlement` and confirmed
  none of the three has a status gate, mirroring `finalizeClaim`'s own
  no-gate design from session 9 — a settlement pipeline mid-decryption
  when `triggerClaimWindow` fires still resolves normally afterward via
  those permissionless finalize calls; only *new* `settleEpoch()` calls
  are blocked. Added the explanatory comment this file's density
  elsewhere led me to expect but didn't find, and a new test
  `test_settleEpoch_revertsWhileClaimWindowOpen` (no epoch warp needed —
  the status check is the first require, so it fails before the timing
  check is ever reached). Verified load-bearing by temporarily loosening
  the require to `status != PoolStatus.Settled` (which would wrongly
  allow `ClaimWindowOpen`) and confirming the new test failed with the
  timing-check's revert message instead, then restoring.

- **Item 2 — reentrancy (medium).** Traced the actual call ordering in
  both `buyCover` and `claim`: both call an external, pluggable
  `IERC7984` token function whose real FHESafeMath return value
  (`transferred`) must be compared against the intended amount before
  `totalLiabilities`/policy state can safely mutate — a genuine,
  unavoidable CEI violation (you cannot know `fullyPaid` before the
  external call returns, not a reorderable ordering issue), confirming
  `nonReentrant` was the right call already in the tree. Confirmed the
  base `ERC7984._update` — the only code path `confidentialTransfer`/
  `confidentialTransferFrom` (the non-`AndCall` variants this pool uses)
  ever reach — makes zero external calls itself, so the real attack
  surface is a malicious/non-conforming `premiumToken` implementation
  overriding `_update` to call back into the pool. Built
  `test/mocks/ReentrantERC7984Mock.sol`: extends `ERC7984Mock`,
  overrides only the two euint64 overloads this pool actually calls,
  each attempting one reentrant call (guarded by an `attempted` flag to
  stay deterministic even when unguarded) before delegating to `super`.
  Two new tests against a dedicated evil-token pool:
  `test_claim_blocksReentrancyViaConfidentialTransfer` (the malicious
  token, which also holds its own real unclaimed policy, attempts a
  second `claim()` as itself during a legitimate claimant's payout) and
  `test_buyCover_blocksReentrancyViaConfidentialTransferFrom` (same
  shape, a pre-computed second valid encrypted input, attempting a
  second `buyCover` as itself). Cross-function reentry (e.g. `buyCover`
  attempting to reenter `claim`) isn't meaningfully testable here since
  the two require mutually exclusive `status` values — same-function
  reentry against the shared `ReentrancyGuard` lock is the correct test
  shape. Verified both load-bearing by temporarily removing
  `nonReentrant` from each function in turn and confirming the
  corresponding test's `reentrancySucceeded()` assertion flipped to
  true, then restoring.

- **Item 3 — oracle staleness as a constructor param (small-medium).**
  Renamed `MAX_ORACLE_STALENESS` (constant) to `maxOracleStaleness`
  (immutable), added `maxOracleStaleness_` to the constructor right
  after `depegThreshold_`, and updated `triggerClaimWindow()` and all
  five constructor call sites (`setUp()`'s `pool`, the
  `fullyFundedPool`/`longTolerancePool`/two `evilPool` fixtures added
  this session, `script/DeployRedoubtCoverPool.s.sol`). New test
  `test_triggerClaimWindow_respectsCustomMaxOracleStaleness` — a pool
  deployed with a 365-day tolerance must tolerate a 2-hour gap the
  shared fixture's 1-hour tolerance would have rejected — is the real
  regression check for this item (a naive "loosen the test's own
  constant" check is self-referentially consistent and proves nothing,
  since the test reads `pool.maxOracleStaleness()` dynamically).
  Verified load-bearing by temporarily hardcoding
  `maxOracleStaleness = 1 hours` in the constructor regardless of the
  passed-in argument, confirming the new test failed with "oracle price
  stale," then restoring.

- **Item 4 — timeout-based abandon functions (large; new state, agreed
  with the user before building).** FHEVM's pull model means a
  `makePubliclyDecryptable` handle never expires — any of this
  contract's finalize* functions can still succeed whenever a fresh KMS
  proof becomes available, no matter how much time has passed, so
  ordinary relayer/KMS downtime already self-heals without any new code.
  This only matters for one specific handle becoming *permanently*
  undecryptable (a KMS-side data-loss bug, not mere downtime) — without
  an escape hatch, that bricks every future `settleEpoch()`/
  `checkSolvency()` forever, since this contract has no admin or upgrade
  path. Added `decryptionTimeout` (immutable constructor param, `1 days`
  in tests/deploy script), justified directly against session 10's
  measured real latency (~28-50s encrypted-input creation, ~3.3-3.6s
  public decrypt) — 1000x+ that worst case, long enough to never trip
  during any plausible transient outage, short enough the pool can't be
  bricked for more than a day. Added a `PendingSince` timestamp per
  existing pending-guard family (`settlementPendingSince` — one clock
  for the whole three-stage pipeline, not reset per stage, since even
  three real decrypts back-to-back are ~10-20s worst case, negligible
  next to a day-scale timeout; `solvencyCheckPendingSince`;
  `claimPendingSince[holder]`, per-holder) and three new permissionless
  functions:
  - `abandonStuckSettlement()` — rolls forward exactly like the existing
    withhold branches for stage 1/2 (`participantCountDecryptionPending`/
    `premiumValueCheckPending`, identical rollback either way). For
    stage 3 (`premiumDecryptionPending`), only `pendingPremiums` is
    rolled forward — `epochParticipantCount` is NOT, since it was
    already implicitly spent once `finalizeParticipantCount` decided to
    proceed past it. Documented caveat, found by writing the stage-3
    test itself: by stage 3 the total was already marked publicly
    decryptable, so anyone who wanted a KMS proof for it off-chain
    already could regardless of this function — abandoning only means
    the pool itself never formalizes that total into `publicReserves`
    via *this* stuck cycle. A bare follow-up `settleEpoch()` with no new
    buyers correctly withholds again on headcount alone (0 <
    `MIN_EPOCH_PARTICIPANTS`) — proven directly in
    `test_abandonStuckSettlement_stage3_rollsForwardOnlyPremiums`
    (originally written to prove value-preservation via a full second
    reveal with 3 new buyers; that version tripped forge-fhevm's
    per-transaction HCU budget from chaining too many sequential FHE ops
    onto one handle lineage across two full cycles — a real property of
    the mock modeling FHEVM's actual sequential-depth cost accounting,
    not a bug in the abandon logic. Rewrote as the cheaper, more precise
    negative proof instead of reaching for `disableHCUDepthLimit()`,
    since the negative proof is what actually demonstrates the
    asymmetry). New event `SettlementDecryptionAbandoned(epoch, stage)`,
    deliberately not reusing `PremiumEpochWithheld` — "timeout" and
    "below threshold" are different reasons and that distinction matters
    to anyone reading the pool's history.
  - `abandonStuckSolvencyCheck()` — clears `solvencyCheckPending` and
    also resets `lastSolvencyCheckEpoch` to the "never" sentinel
    (`type(uint256).max`): the abandoned check's bit was never finalized
    on-chain, so the once-per-epoch bracketing guard (session 15) has
    nothing to protect against here, and a fresh check must be
    initiable immediately, even in the same epoch. New event
    `SolvencyCheckAbandoned()`.
  - `abandonStuckClaim(holder)` — **a real bug caught by writing the
    test, not by reasoning alone.** The first implementation cleared
    `claimDecryptionPending[holder]` and left `policies[holder].claimed`
    false, matching the settlement/solvency shape ("may retry
    afterward"). `test_abandonStuckClaim_allowsRetryAfterTimeout` (the
    original name) failed with `fullyPaid == false` on the retry — not a
    test bug, a real design flaw: `claim()`'s
    `premiumToken.confidentialTransfer(...)` executes synchronously and
    unconditionally the moment `claim()` is called, real funds already
    moved (or didn't) before the KMS decryption ever gets stuck. Unlike
    the settlement/solvency guards (pure encrypted bookkeeping, no
    external call, so rollback-and-retry is unconditionally safe),
    allowing a retry here risks a SECOND real transfer of the same
    `payoutAmount` stacked on an already-successful first one — a direct
    double-payment, not just a bookkeeping inconsistency. Fixed by
    marking `policies[holder].claimed = true` on abandonment instead,
    unconditionally foreclosing any further `claim()` attempt for that
    holder — accepting a possible false negative (a holder whose stuck
    attempt actually failed, i.e. transferred 0, is now wrongly locked
    out of ever retrying a legitimate claim) as the deliberate,
    conservative trade: a wrongly-denied claim is a support-channel
    problem, a double payment is a direct fund drain undermining the
    exact guarantee `checkSolvency` exists to prove. `totalLiabilities`
    is deliberately left untouched either way — the true past outcome is
    unknowable from on-chain state, so not adjusting it is the
    conservative default (worst case, `checkSolvency` reports MORE
    pessimistically than the real truth, never less). Renamed the test
    to `test_abandonStuckClaim_forecloseRetryAfterTimeout` to match what
    it actually now proves. Verified load-bearing by temporarily
    removing the `claimed = true` line and confirming the test failed
    (the retry no longer reverted with "already claimed"), then
    restoring.
  - **What this closes:** a single permanently-lost decryption request
    (settlement, solvency, or one holder's claim) can no longer brick
    that pending-guard family forever. **What this does NOT close:**
    ordinary relayer/KMS downtime never needed this in the first place
    (the pull model already self-heals); this is a backstop for a
    narrower, rarer failure mode, and for claims specifically it
    resolves that failure mode by conservatively favoring "possibly
    wrongly denied" over "possibly double-paid," not by actually
    recovering the claimant's true entitlement.

- **Item 5 — gas profiling (small).** `forge test --gas-report` on
  `buyCover`: **921,488 gas**, essentially unchanged from before this
  session (921,466 — the two-function `nonReentrant` overhead already
  existed). Deployment cost grew from 2,930,804 to 3,210,807 gas (+~9.6%,
  three new functions and several new state variables) — still far under
  any realistic L1/L2 block gas limit (~30M on Sepolia/mainnet). No
  optimization work done; none needed.

- **Full suite: 43/43 (44/44 incl. skeleton),** up from session 15's
  32/32 (33/33) — eleven new tests across items 1, 2, and 4 (item 3 and
  5 added no new passing-count beyond the one constructor-wiring test
  folded into item 3's count).

**Session 17 — Sepolia redeploy against session 15/16's hardened constructor
signature, frontend rewired to match (no protocol logic changes this
session):**

- **Why:** session 10's live pool predates `minEpochPremiumTotal_`
  (session 15) and `maxOracleStaleness_`/`decryptionTimeout_` (session 16) —
  its on-chain constructor doesn't match current `RedoubtCoverPool.sol` at
  all, so a fresh instance was needed before any further live demo work.
- **Confirmed first, not assumed:** `script/DeployRedoubtCoverPool.s.sol`'s
  constructor call already matched the current 9-arg signature exactly
  (`premiumToken_, premiumRateBps_, epochLength_, priceOracle_,
  depegThreshold_, maxOracleStaleness_, claimWindowDuration_,
  minEpochPremiumTotal_, decryptionTimeout_`) — apparently updated silently
  during session 15/16's own work and never flagged, similar to session 16's
  own "already sitting in the tree" discovery. Verified against
  `RedoubtCoverPool.sol`'s actual constructor before trusting it. Full
  suite re-confirmed green (43/43, 44/44 incl. skeleton) before deploying.
- **Values used, and why (unchanged from session 15/16's own reasoning,
  reused rather than re-derived):** `premiumRateBps=500` (5%),
  `epochLength=300s`, `claimWindowDuration=300s` — demo-scale per session
  10's original reasoning, so real on-chain deadlines elapse in wall-clock
  time within a session, not a production recommendation.
  `depegThreshold=95_000_000` against `initialPrice=100_000_000` (1e8 fixed
  point, standard 5% stablecoin-depeg definition). `minEpochPremiumTotal=
  5_000_000` (5 USDC in cUSDCMock's 6 decimals) — session 15's own sizing,
  reused as-is since the underlying token and demo scale haven't changed.
  `maxOracleStaleness=3600` (1 hour) and `decryptionTimeout=86400` (1 day) —
  session 16's own demo-scale values, same logic as epochLength/
  claimWindowDuration: long enough to tolerate this demo's oracle-update
  cadence and session 10's measured real KMS/relayer latency (~28-50s
  encrypt, ~3.3-3.6s decrypt — 1 day is 1000x+ that worst case), short
  enough neither guard is weakened to the point of being meaningless. Not
  re-derived from scratch — reused because the demo's shape (single
  sitting, Sepolia, same token) hasn't changed.
- **Deployed contracts (Sepolia):** dry-run first (`forge script` without
  `--broadcast`, ~0.0088 ETH estimated, deployer had ~0.056 ETH — confirmed
  before spending). `MockPriceOracle` at
  `0xb7862C0bD3992CF66aAAe3cD6187adc072263bc4`; `RedoubtCoverPool` at
  `0x7E880F20B7dD8D307e150b0f59578c4eC20D193A` (both verified on Etherscan
  via `forge verify-contract` — `MockPriceOracle` came back "already
  verified" immediately, Etherscan's bytecode-match verification
  recognizing identical creation code to a previously-verified contract;
  `RedoubtCoverPool` submitted fresh and passed). Same `premiumToken`
  (`cUSDCMock`, `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`) reused
  unchanged from session 10 — not re-derived, already independently
  verified real and valid.
- **Sanity check only, not a full relayer-flow re-run** (correctly out of
  scope per this session's brief — this is a redeploy of already-verified
  logic, not a fresh integration test): `cast call` against the new pool
  confirmed `status()==0` (Active), `currentEpoch()==0`, `publicReserves()
  ==0`, and all five new/changed constructor-derived getters
  (`premiumRateBps`, `maxOracleStaleness`, `decryptionTimeout`,
  `minEpochPremiumTotal`) read back exactly the deployed values.
- **Frontend rewired:** `frontend/src/lib/contracts.ts`'s `CONTRACTS`
  updated to the two new addresses (`premiumToken` untouched).
  `frontend/src/lib/abi/RedoubtCoverPool.json` was stale — missing session
  15/16's constructor params and every new function/event
  (`abandonStuckSettlement`/`abandonStuckSolvencyCheck`/
  `abandonStuckClaim`, `MAX_ORACLE_STALENESS` rename, etc.) — re-copied
  fresh from `contract/out/RedoubtCoverPool.sol/RedoubtCoverPool.json` per
  session 11's own documented "re-copy by hand if the contract changes"
  note. `IERC7984.json`/`IPriceOracle.json` diffed byte-for-byte identical
  to the current build output, left untouched. `pool-status-card.tsx`'s
  five reads (`status`/`currentEpoch`/`publicReserves` on the pool,
  `decimals`/`symbol` on the token) have unchanged signatures across this
  redeploy; confirmed working directly via `cast call` against the new
  address (equivalent to what `useReadContracts` calls) rather than
  through a browser session — no injected-wallet browser is available in
  this environment. `npx tsc --noEmit` and `npm run build` both clean
  after the ABI refresh.
- **Explicitly not touched this session, per the brief:** no pool-creation/
  factory UI, no `RedoubtCoverPool.sol` logic changes, no `buyCover`/
  `claim`/EIP-712 frontend work (still queued per §12).

**Session 18 — `buyCover` frontend: real encrypted-input construction via
`@zama-fhe/relayer-sdk` in the browser, the app's first live encrypted
write, not just reads.**

- **Node compat, independently re-checked, not copied forward from session
  10.** This environment runs Node 20.19.4. `@zama-fhe/relayer-sdk@0.4.4`
  (`engines.node >= 22`) installed with only an `EBADENGINE` warning — same
  outcome as session 10's Node-script install, but re-verified fresh rather
  than assumed to still hold.
- **Genuinely new finding, not a repeat of session 10 (which only ever used
  the `/node` subpath):** the package has no root `.` export — only
  `./web`, `./node`, `./bundle` (`./bundle` re-exports `./web`), and
  `./package.json`. The browser build (`@zama-fhe/relayer-sdk/web`) exports
  an `initSDK()` function the Node build does not: it loads the TFHE/KMS
  WASM plus a `wasm-bindgen-rayon` worker pool, and **must be awaited once
  before the first `createInstance()` call**. Session 10's Node scripts
  never needed this — the `/node` subpath initializes synchronously via
  native bindings. Built `frontend/src/lib/fhevm.ts` around this: a
  `getFhevmInstance(provider)` singleton that awaits a shared `initSDK()`
  promise once, then `createInstance({...SepoliaConfig, network: provider})`,
  caching per-provider and clearing the cache on failure so a transient
  init error doesn't permanently wedge future attempts behind one rejected
  promise.
- **`network` is the connected wallet's own EIP-1193 provider, obtained via
  wagmi's `connector.getProvider()`, not `window.ethereum` directly and not
  a raw RPC URL string.** `FhevmInstanceConfig.network` accepts
  `Eip1193Provider | string` (confirmed in `lib/web.d.ts`); reaching for
  `window.ethereum` directly would assume it's necessarily the same
  provider wagmi's active connector is using, which doesn't generally hold
  under multi-wallet/EIP-6963 conditions — `connector.getProvider()` is the
  correct wagmi-idiomatic source and costs nothing extra. Simpler than
  session 10's Node scripts, which had no browser wallet at all and had to
  pass `cfg.RPC_URL` instead.
- **`RelayerEncryptedInput.encrypt()` returns `{ handles: Uint8Array[],
  inputProof: Uint8Array }`**, not hex strings (confirmed in `lib/web.d.ts`)
  — session 10's ethers script converted these via `ethers.hexlify(...)`;
  the viem/wagmi equivalent used here is `bytesToHex(...)`, matching
  `buyCover`'s ABI (`bytes32`, `bytes`).
- **Built `frontend/src/components/redoubt/buy-cover-card.tsx`**, wired
  into `frontend/src/app/app/page.tsx` below `PoolStatusCard`. Reuses
  `CaseFileFrame`/`DataRow`/shadcn `Card`/`Alert`/`Button` — no new visual
  language. Flow:
  - **Operator grant gated on real on-chain state, not assumed.** Reads
    `isOperator(holder, pool)` on the premium token (ERC-7984's own gate on
    `confidentialTransferFrom`, per this file's own load-bearing lessons
    list); if false, renders a `setOperator(pool, until)` step before the
    coverage form unlocks. `until = now + 30 days` — a UI choice (the
    contract doesn't mandate any particular grant length), chosen longer
    than session 10's own 1-day scratch-script value since this is a
    repeatable app, not a single scripted session.
  - **FHEVM instance pre-warmed on wallet connect, not on submit.** Session
    10 measured `createInstance()`'s one-time public-key/CRS fetch at
    ~10s, separate from the ~28-50s per-call `encrypt()`. The component
    kicks off `getFhevmInstance()` as soon as a wallet is connected on
    Sepolia, in the background, so only the genuinely per-call cost is
    paid at submit time.
  - **Loading state actually surfaces `timing.ts`'s `TIMING_TIER.encryptedInput`**
    (previously defined, session 11, but unused until now) with a live
    elapsed-seconds counter instead of a bare spinner or a determinate
    progress bar — real duration varies 28-50s and a bar that stalls partway
    would misrepresent that.
  - **Post-purchase state reads the public `policies(address)` mapping**
    (`coverage` handle, `epochBought`, `claimed` — only `coverage`'s
    underlying euint64 value is encrypted, the struct fields around it are
    plaintext) to show "open policy, bought epoch N" without any decrypt
    step, matching this session's explicit scope boundary. EIP-712
    user-decrypt of the coverage amount itself is session 19's scope, not
    this one.
- **IPv6/relayer `fetch failed` handling, deliberately not blindly
  reapplied:** session 10's fix (`NODE_OPTIONS=--dns-result-order=ipv4first`)
  is Node-only and has no browser equivalent; this session's code makes no
  attempt to "fix" that in the browser. No such failure was actually
  observed this session (see verification note below on why) — if one
  surfaces later from a real browser, it must be written up as a new,
  distinct browser-specific finding, not filed under session 10's
  already-closed Node diagnosis.
- **Verification, and its real limit:** `npx tsc --noEmit` clean.
  `npm run build` — [[BUILD_RESULT]]. Per session 17's own documented
  limitation ("no injected-wallet browser is available in this
  environment"), this session could not drive a real wallet-approval +
  live relayer round-trip + on-chain `buyCover` end-to-end; verification
  here is compile/type-level plus a direct trace of every ABI/SDK type
  against the installed package sources (`lib/web.d.ts`,
  `RedoubtCoverPool.json`, `IERC7984.json`), not a live run. Stated plainly
  rather than implied as tested.
- **Explicitly not touched this session:** `RedoubtCoverPool.sol` (no
  contract changes), `claim()` UI, EIP-712 user-decrypt (session 19),
  `pool-status-card.tsx`'s existing reads.

Full reasoning trail: see [CLAUDE_HISTORY.md](./CLAUDE_HISTORY.md).

## 1. What we're building, in one sentence

A single-peril confidential insurance pool where coverage amounts,
premiums, and payouts are encrypted end to end (ERC-7984 + FHEVM euint64),
and the pool proves it can pay every claim by comparing encrypted total
liabilities against public reserves — without ever revealing what any
individual is owed.

## 2. Why this project, not the alternatives (full reasoning trail)

This was chosen after evaluating five other ideas for Zama's Season 3
Developer Program. Keep this section — it explains *why* certain design
constraints exist, which matters when you're tempted to "simplify."

- **Netting batcher** (MEV-blind execution via encrypted order
  aggregation) — rejected for this builder's context because its privacy
  guarantee is literally zero below ~10 concurrent participants, and it
  competes against free incumbents (Flashbots Protect, private mempools).
  The batcher's core lesson still applies here and shapes Redoubt
  directly: **no public event should correspond to exactly one person's
  secret.** That principle is why Redoubt batches premium settlement and
  claims by epoch instead of settling immediately.
- **Confidential lending (liquidation-by-boolean)** — the other finalist.
  Rejected in favor of Redoubt only because Redoubt has a cleaner
  "why FHE, not ZK" argument (see §3) and an empty competitive lane,
  whereas confidential lending is where the ecosystem's own commercial
  activity (GSR/Zama OTC trade, institutional dark-pool narrative) is
  already headed.
- **Encrypted order book, dark triggers, threshold-compliance rails** —
  scoped in the original brainstorm but not pursued. Order book has prior
  art (an EthCC hackathon dark-pools project, plus Zama's own GSR OTC
  trade puts institutional dark-pool execution in Zama's commercial lane
  already). Dark triggers is architecturally close to Redoubt's claim
  trigger — if Redoubt ever needs a second peril type, revisit this.

**Naming:** Redoubt = a small fortified refuge. Checked against existing
crypto projects — clean namespace (unlike Umbra, which collides with both
ScopeLift's stealth-payment protocol AND Umbra Privacy, a funded Solana
privacy protocol with a live token; and Velum, which collides with a
post-quantum CLI encryption tool).

## 3. Why FHE, specifically (the question every judge asks first)

Solvency is a **joint computation over every policyholder's secret**. A ZK
proof lets one user prove a fact about their own input — it cannot prove
an aggregate fact ("the sum of everyone's coverage is within reserves")
without someone first collecting all the plaintext inputs. A trusted
server that could see everyone's coverage recreates the exact
surveillance problem the protocol exists to solve: **buying cover in
plaintext announces what you're afraid of losing**, which is itself
exploitable information (a $2M depeg-cover purchase reveals a $2M
position in that asset).

If asked to defend this in a demo: FHE is not being used here because it's
novel, it's being used because the alternative (plaintext coverage
amounts) is a direct information leak with no mitigation.

## 4. Mechanism (three parts — this is the whole pitch)

1. **Blind underwriting.** `buyCover` takes an encrypted coverage amount
   (`externalEuint64` + ZK proof of well-formedness, per FHEVM's standard
   external-input pattern). Premium = `coverage * rateBps / 10_000`,
   computed homomorphically. Division here is **division by a plaintext
   constant** (10_000), which `FHE.div` supports — ciphertext-to-ciphertext
   division is NOT supported by FHEVM and must never be attempted anywhere
   in this codebase.
2. **Encrypted solvency proof.** The pool keeps a running encrypted sum of
   all liabilities (`totalLiabilities`). `checkSolvency` does a single
   `FHE.le(totalLiabilities, publicReserves)` and requests decryption of
   **only the resulting ebool** — "solvent: true/false" — never any
   underlying amount.
3. **Leakage-resistant claims.** Claims can only open after a **public,
   undeniable** oracle event (price crosses `depegThreshold`). Payout
   amounts remain encrypted ERC-7984 transfers, settled per epoch, not
   immediately per-claim.

## 5. v1 scope — deliberately narrow, do not expand without asking

**In scope:**
- One peril: depeg of a single ERC-7984-wrapped stablecoin.
- One trigger: a public price oracle crossing a fixed threshold.
- One pool. No tranches, no secondary market, no governance.

**Explicitly cut, do not build unless asked:**
- Multiple perils / multiple pools
- Dynamic premium curves
- Partial claims / partial payouts
- DAO governance of parameters
- Pro-rata proportional settlement (see §7 — this was cut on purpose
  because it requires ciphertext division and dust handling; v1 uses flat
  full-coverage payout instead)

## 6. Leakage model — this is not a fully private system, document every leak

This table belongs in the README verbatim once written. It is not
optional polish — it is the artifact that proves the team understood the
threat model rather than assuming "encrypted" means "invisible."

| Event | Visible | Hidden | Residual risk |
|---|---|---|---|
| `buyCover` | that an address bought cover, in which epoch | coverage amount, premium amount | timing correlation if very few buyers in an epoch |
| `settleEpoch` | epoch's **total** premiums once decrypted | each buyer's individual premium | thin epochs, both by headcount (MIN_EPOCH_PARTICIPANTS) and by value (minEpochPremiumTotal, session 15) — see guards below |
| `checkSolvency` | one bit: solvent true/false | total liabilities, reserve composition | **MITIGATED, not solved (session 15)**: rate-limited to once per epoch, so one buy/claim can no longer be bracketed within a single epoch — a patient attacker checking once per epoch over many epochs can still attempt slower, noisier inference via the reserve delta trend |
| `claim` | that an address claimed | payout amount (still ERC-7984 encrypted) | claim timing correlates with known public depeg time; mitigated by batched claim windows |

**Guard implemented:** `MIN_EPOCH_PARTICIPANTS` (3) withholds premium
decryption entirely if fewer than 3 policies were bought in an epoch — the
pending amount rolls into the next epoch instead of settling. An aggregate
of one or two participants isn't an aggregate, it's a leak with extra
steps.

**Guard implemented, session 15:** `minEpochPremiumTotal` (immutable
constructor param, not a hardcoded constant — see the state-variable
comment in `RedoubtCoverPool.sol` for why a token/market-specific value
can't be a protocol-wide constant the way `MIN_EPOCH_PARTICIPANTS` is)
withholds premium decryption if the epoch's real total is too low, even
when headcount clears `MIN_EPOCH_PARTICIPANTS`. Checked via a still-
encrypted `FHE.ge` comparison in `finalizeParticipantCount`, with only the
resulting bit (not the total) marked decryptable in a new intermediate
`finalizePremiumValueCheck` stage — checking the real total by decrypting
it first and withholding after the fact would already have leaked it
off-chain regardless of the contract's own decision, the identical
ordering trap session 8 solved for participant-count-vs-total. **What
this does not do:** it raises the cost of padding with many tiny/dust
payments specifically; it does not stop a well-funded attacker from
padding headcount with several moderately-sized real payments instead —
that still clears both guards. Headcount-only sybil padding itself
remains open (§0).

**Mitigated, session 15 (was previously an open problem — see
CLAUDE_HISTORY.md for the full before/after reasoning):** Repeated
`checkSolvency` calls immediately before/after a single `buyCover` used to
let an observer bracket that buyer's coverage via the reserve delta
between two solvency snapshots. `checkSolvency()` is now rate-limited to
at most once per `currentEpoch` (tracked via `lastSolvencyCheckEpoch`,
independent of the existing `solvencyCheckPending` in-flight guard — both
must hold). **What this closes:** an attacker can no longer sandwich a
single `buyCover` between two solvency checks within the same epoch —
every other buyer's activity in that epoch now falls between any two
allowed checks. **What this does NOT close:** an attacker checking once
at the start and once at the end of every epoch, over many epochs,
watching the reserve delta trend over time, could still attempt slower,
noisier inference — harder and slower now, not impossible. Candidate
mitigations not built: (b) require N intervening transactions between
checks, (c) add synthetic noise to `publicReserves` reporting — still
available future hardening if the epoch-level rate limit alone proves
insufficient.

## 7. Explicit non-goals / things cut on purpose (say why, don't just omit)

- **No ciphertext division anywhere.** FHEVM's `FHE.div`/`FHE.rem` only
  accept plaintext divisors. Any design that requires dividing one
  ciphertext by another (e.g. true pro-rata proportional payout across
  many claimants) is out of scope for v1. If a future feature seems to
  need it, stop and redesign around cross-multiplication instead, the
  same way the solvency check avoids `liabilities / reserves` by doing
  `FHE.le(liabilities, reserves)` instead.
- **No per-transaction premium decryption.** Every premium reveal is
  epoch-batched. This was the single biggest lesson carried over from an
  earlier "netting batcher" design that was ultimately not built: solo
  low-participant flows make individual-level decryption trivially
  reversible.

## 8. Toolchain — Foundry, using forge-fhevm

We are using **Foundry**, not Hardhat. Use `zama-ai/forge-fhevm`
(https://github.com/zama-ai/forge-fhevm) — a Foundry-native library that
deploys the actual FHEVM host contracts (FHEVMExecutor, ACL,
InputVerifier, KMSVerifier) as UUPS proxies inside Foundry's test
environment. It intercepts FHE-operation events via `vm.getRecordedLogs()`
and maintains a local plaintext database mapping encrypted handles to
cleartext values — tests exercise real contract code paths, not a
simplified mock. Only deviation from mainnet: mock private keys for the
input signer and KMS signer (deterministic EIP-712 proof generation).

**Requirements:**
- Solidity `^0.8.27`
- `evm_version = "cancun"` in `foundry.toml`

**Fresh init:**
```bash
forge init redoubt
cd redoubt
forge install zama-ai/forge-fhevm
```

Confirm the exact install path/remapping and the exact ERC-7984 /
`@fhevm/solidity` dependency source from the current forge-fhevm README
before assuming npm-style paths — Foundry dependency management differs
from the hardhat/npm conventions this design conversation originally used,
and forge-fhevm is evolving quickly (updated as recently as Feb 2026).

**foundry.toml additions:**
```toml
[profile.default]
solc_version = "0.8.27"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
```

**Local testing:** forge-fhevm ships a `deploy-local.sh` script that
deploys FHEVM host contracts to a local anvil node at deterministic
addresses, and a `FhevmTest` base contract for Forge tests — inheriting
it and calling `super.setUp()` should stand up the full host-contract
environment automatically. Verify the exact base contract name/API in the
installed library source rather than assuming.

**Config contract (CONFIRMED, corrected from earlier draft):** the config
contract is `ZamaEthereumConfig`, not `SepoliaConfig` — `SepoliaConfig`
does not exist in the installed `@fhevm/solidity` (0.11.1).
`ZamaEthereumConfig` auto-detects the network via `block.chainid` inside
its own constructor (1 = mainnet, 11155111 = Sepolia, 31337 = local
anvil), so there is only one config contract to inherit everywhere:

```solidity
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract RedoubtCoverPool is ZamaEthereumConfig {
    // ...
}
```

**Dependency resolution (CONFIRMED):** forge-fhevm resolves its own
dependencies (`@fhevm/solidity`, `encrypted-types`, OpenZeppelin
contracts/upgradeable, `@openzeppelin/confidential-contracts`) via
Foundry's native soldeer integration, not git submodules or npm. This
happens automatically on `forge install zama-ai/forge-fhevm` — no manual
`forge soldeer install` step needed. Root `remappings.txt` must point
directly into `lib/forge-fhevm/dependencies/...` since these packages are
not installed at the project's own top level. Confirmed working
remappings (versions will drift — re-verify against whatever forge-fhevm
resolves at install time, don't copy these blindly forever):

```
forge-fhevm/=lib/forge-fhevm/src/
@fhevm/solidity/=lib/forge-fhevm/dependencies/@fhevm-solidity-0.11.1/
encrypted-types/=lib/forge-fhevm/dependencies/@encrypted-types-0.0.4/
@openzeppelin/confidential-contracts/=lib/forge-fhevm/dependencies/@openzeppelin-confidential-contracts-7ac7cee/contracts/
@openzeppelin/contracts-upgradeable/=lib/forge-fhevm/dependencies/@openzeppelin-contracts-upgradeable-5.1.0/
@openzeppelin/contracts/=lib/forge-fhevm/dependencies/@openzeppelin-contracts-5.1.0/
forge-std/=lib/forge-std/src/
```

## 9. What to build — project structure and file responsibilities

**Note on location:** the Foundry project lives in `Redoubt/contract/`,
not the repo root — `CLAUDE.md` and `.claude/` stay at the parent level,
leaving room for a sibling `frontend/` directory later.

Foundry-standard layout (inside `contract/`):

```
contract/
├── src/
│   ├── RedoubtCoverPool.sol
│   ├── interfaces/
│   │   ├── IConfidentialFungibleToken.sol
│   │   └── IPriceOracle.sol
│   └── mocks/
│       └── MockPriceOracle.sol
├── script/
│   └── DeployRedoubtCoverPool.s.sol
├── test/
│   └── RedoubtCoverPool.t.sol
├── foundry.toml
└── remappings.txt
```

### `src/RedoubtCoverPool.sol` — the core contract

Build this to implement §4's mechanism exactly. Required pieces:

- **State:** encrypted running total of liabilities (`euint64`), encrypted
  pending premiums for the current epoch (`euint64`), public reserve
  balance (`uint256`, plaintext), per-user `Policy` struct holding
  encrypted coverage + epoch bought + claimed flag, epoch tracking
  (current epoch number, epoch start timestamp, epoch length), pool status
  enum (`Active` / `ClaimWindowOpen` / `Settled`).
- **`buyCover(externalEuint64 encryptedCoverage, bytes calldata proof)`**
  — converts external input via `FHE.fromExternal`, computes premium via
  plaintext-divisor `FHE.div`, pulls premium via ERC-7984
  `confidentialTransferFrom`, updates running totals, stores the policy,
  grants ACL access to the holder for their own coverage ciphertext.
- **`settleEpoch()`** — if `epochParticipantCount[currentEpoch] <
  MIN_EPOCH_PARTICIPANTS`, emit `PremiumEpochWithheld` and roll the epoch
  without decrypting anything. Otherwise request decryption of the pending
  premium sum via `FHE.requestDecryption` + callback, which adds the
  revealed total to `publicReserves` and rolls the epoch.
- **`checkSolvency()`** — single `FHE.le(totalLiabilities,
  FHE.asEuint64(uint64(publicReserves)))`, request decryption of the
  resulting `ebool` only, emit `SolvencyChecked(bool)` from the callback.
- **`triggerClaimWindow()`** — reads the public oracle's `latestPrice()`,
  requires it below `depegThreshold`, flips pool status to
  `ClaimWindowOpen`. No FHE involved here — this must stay a plain public
  fact check.
- **`claim()`** — requires `ClaimWindowOpen`, marks the caller's policy
  claimed, pays out the caller's full encrypted coverage via ERC-7984
  `confidentialTransfer`. No plaintext amount in any event.
- **Events:** deliberately coarse. `PolicyOpened(address, epoch)`,
  `PremiumEpochSettled(epoch, revealedTotal)`,
  `PremiumEpochWithheld(epoch, participantCount)`,
  `SolvencyChecked(bool)`, `ClaimWindowTriggered(epoch, oraclePrice)`,
  `ClaimEpochSettled(epoch)`. None of these may carry a single user's
  coverage, premium, or payout amount.
- **ACL discipline:** every encrypted state variable needs an explicit
  `FHE.allowThis` (so the contract itself can keep operating on it in
  future calls) and, where a specific user should be able to decrypt
  something (e.g. their own coverage), an explicit `FHE.allow(value,
  user)`. FHEVM defaults to nobody having decrypt access — a missing ACL
  grant is the most common FHEVM bug and fails silently on the frontend,
  not at compile time.

### ERC-7984 interface (CONFIRMED: use the real one, no hand-rolled fallback)

`IERC7984.sol` is already resolved as part of forge-fhevm's own dependency
tree (`@openzeppelin/confidential-contracts`) — confirmed present in build
output. Import it directly:

```solidity
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
```

Do not write a hand-rolled `IConfidentialFungibleToken.sol` fallback — an
earlier draft of this doc proposed one before the real dependency was
confirmed available. Using the real interface means genuine compatibility
with actual Wrappers Registry tokens later, not just a lookalike stub.

### `src/interfaces/IPriceOracle.sol`

`latestPrice() external view returns (uint64)`, documented as 1e8 fixed
point. Deliberately plaintext, not encrypted — the depeg trigger must be a
fact anyone can verify without any decryption step.

### `src/mocks/MockPriceOracle.sol`

Owner-settable price, for locally simulating a depeg event in tests
without a live feed.

### `script/DeployRedoubtCoverPool.s.sol`

Foundry deploy script. Needs a real ERC-7984 token address (a cTokenMock
from the Zama Wrappers Registry for Sepolia deploys — do not fabricate a
placeholder token for anything beyond the earliest local scaffolding),
plus the mock oracle for local/dev deploys, plus constructor params:
depeg threshold, premium rate in bps, epoch length in seconds.

## 10. Test plan (properties that matter most, in priority order)

Write `test/RedoubtCoverPool.t.sol` using forge-fhevm's Forge-native
testing base. Priority order:

1. **Thin-epoch withholding.** 1-2 signers buy cover, warp past
   `epochLength`, call `settleEpoch()`. Assert `PremiumEpochWithheld`
   fires, NOT `PremiumEpochSettled`. This is the single most important
   test in the suite — it's the leakage-model guarantee made executable.
2. **Epoch settlement with sufficient participants.** ≥3 signers buy
   cover, warp, settle. Assert `PremiumEpochSettled` with correct
   aggregate total, and that `publicReserves` increased by that amount.
3. **Solvency check correctness.** Seed known encrypted liabilities and
   public reserves, call `checkSolvency`, assert the decrypted ebool
   matches manual arithmetic. Test both solvent and insolvent cases.
4. **Solvency check never touches division.** Code-review-level check —
   grep the contract for `FHE.div`/`FHE.rem` calls outside the
   premium-by-plaintext-constant calculation; there should be none in
   `checkSolvency`.
5. **Claim gating on oracle.** Assert `triggerClaimWindow` reverts when
   price is above `depegThreshold`, succeeds when below.
6. **Claim payout via confidential transfer.** Assert a claim transfers
   the correct encrypted coverage amount and that no plaintext amount
   appears in any emitted event or return value.
7. **ACL correctness.** For every encrypted state variable a user should
   be able to read (e.g. their own `Policy.coverage`), assert
   `FHE.allow` was actually granted — test by attempting a decrypt as
   that user and as a random third party (should fail for the third
   party).

## 11. Hardening — edge cases that must be handled, not discovered

These are not hypothetical. Each one will actually break the contract if
left unhandled, and none of them show up until you run real transactions
against real FHEVM host contracts (not by reading the code).

- **`settleEpoch()` called while `status == ClaimWindowOpen`.** ✅
  **Resolved, session 16.** `require(status == PoolStatus.Active, ...)`
  blocks new cycles; in-flight finalization has no status gate at all and
  still resolves after `ClaimWindowOpen`. See §0 session 16, item 1.
- **Reentrancy on `confidentialTransfer`/`confidentialTransferFrom`.** ✅
  **Resolved, session 16.** `ReentrancyGuard`/`nonReentrant` on `buyCover`
  and `claim` — confirmed the correct call given a genuine, unavoidable
  CEI violation, and proven against an actually malicious token mock, not
  just asserted. See §0 session 16, item 2.
- **Stale oracle price.** ✅ **Resolved, session 16.** `lastUpdated()` on
  `IPriceOracle`/`MockPriceOracle`, checked in `triggerClaimWindow()`
  against `maxOracleStaleness` — a constructor param, not a hardcoded
  constant, per the same deployment-specific reasoning as
  `depegThreshold`. See §0 session 16, item 3.
- **Decryption callback race / duplicate requests.** ✅ Already resolved
  by session 8's independent pending-guards
  (`participantCountDecryptionPending`/`premiumValueCheckPending`/
  `premiumDecryptionPending` for settlement, `solvencyCheckPending` for
  solvency, `claimDecryptionPending[holder]` per claim) — confirmed
  still correctly independent as of session 16's audit.
- **KMS/relayer callback never arrives.** ✅ **Resolved, session 16.**
  FHEVM's pull model already self-heals ordinary downtime (a
  publicly-decryptable handle never expires); `abandonStuckSettlement()`/
  `abandonStuckSolvencyCheck()`/`abandonStuckClaim(holder)` are the
  backstop for one specific handle becoming *permanently* undecryptable,
  gated on a `decryptionTimeout` constructor param. Claims are handled
  conservatively (forecloses retry rather than allowing one) for reasons
  specific to `claim()` alone — see §0 session 16, item 4, including a
  real double-payment bug this design caught and fixed before it shipped.
- **Gas cost of ciphertext operations.** ✅ **Profiled, session 16.**
  `buyCover`'s `FHE.mul`→`FHE.div` chain costs ~921k gas on forge-fhevm's
  mock, comfortably under any realistic L1/L2 block gas budget, and real
  Sepolia deploys/calls already succeeded (session 10). No optimization
  needed. See §0 session 16, item 5.
- **Local mock coprocessor vs. real testnet behavior can differ.**
  forge-fhevm deploys real host contracts locally, which is why it was
  chosen over a simplified mock — but confirm this explicitly once tests
  are passing locally: deploy to Sepolia and re-run the same manual flow
  (§12 MVP checklist) before trusting local test results as sufficient.
  Async callback timing in particular (how long a real KMS decryption
  takes vs. instant local resolution) will not show up locally at all.

None of the above are optional polish — they are the difference between a
contract that works in a demo and one that works. Do not treat this
section as lower priority than §9's feature list; schedule time for it
explicitly rather than only after "the happy path is done."

## 12. Integration effort — do not underestimate this

Getting `buyCover` → `settleEpoch` → `checkSolvency` → `claim` working
against a **real** ERC-7984 token, the actual relayer, and real KMS
decryption timing on Sepolia is a genuinely multi-session effort, not a
checklist item to tick off quickly. Specific things that take real time:

- Getting a cTokenMock from the Zama Wrappers Registry correctly wired
  with ACL permissions so this contract can actually call
  `confidentialTransferFrom` on a user's behalf.
- The EIP-712 user-decryption flow for a policyholder to view their own
  coverage — this involves signature generation on the frontend and is a
  common source of "it compiles but doesn't work" bugs.
- Real KMS decryption latency (seconds to potentially longer, not
  instant) means every async flow in this contract needs to be tested
  with realistic delays, not just local mock-speed resolution.
- ACL permission failures fail **silently** — a missing `FHE.allow` shows
  up as a frontend read returning nothing useful, not a revert. Budget
  real debugging time here specifically.

## 13. MVP definition — what "done" means for a first working demo

- [ ] `forge init` + `forge install zama-ai/forge-fhevm` complete, project
      compiles
- [ ] `RedoubtCoverPool.sol` and supporting interfaces/mocks written per
      §9
- [ ] All tests in §10 passing against forge-fhevm's real host contracts
      (not a simplified mock)
- [ ] Deploy script working against local anvil + a real ERC-7984
      cTokenMock (get one from the Zama Wrappers Registry, don't build a
      fake one for anything beyond earliest scaffolding — using the
      official mock is itself a small credibility signal)
- [ ] End-to-end manual flow works on local anvil: buy cover (2+ wallets)
      → settle epoch → check solvency (true) → set oracle price below
      threshold → trigger claim window → claim → verify encrypted payout
- [ ] README committed with the leakage-model table from §6 verbatim
- [ ] Minimal frontend (can be a simple script/CLI initially, not
      required to be a polished UI for MVP) demonstrating the EIP-712
      user-decryption flow for a policyholder to view their own coverage
- [ ] Every edge case in §11 either handled or explicitly documented as a
      known limitation with a stated reason — not silently unhandled

## 14. Working agreement for Claude Code sessions

- This is being built incrementally ("little by little"), not in one
  shot. Prefer small, reviewable diffs over large rewrites. Confirm scope
  of each session's work before generating a large batch of files.
- Do not silently change the leakage-model design (§6) or the v1 scope
  boundaries (§5) — if a limitation there seems wrong, say so and ask,
  don't just fix it.
- Do not introduce ciphertext division anywhere. If a feature seems to
  need it, stop and flag it — this is a hard architectural constraint,
  not a style preference.
- Verify current FHEVM/forge-fhevm API details against the actual
  installed library source rather than assuming this doc's syntax is
  perfectly current — forge-fhevm is actively evolving.
- Every new encrypted state variable needs an explicit ACL grant
  (`FHE.allowThis` and/or `FHE.allow`) in the same function that creates
  it. This is the most common FHEVM footgun.

## 15. Frontend (`frontend/` — session 11 status screen, session 12 marketing page, session 18 buyCover flow)

**Stack:** Next.js 16 (App Router, Turbopack) + TypeScript + Tailwind v4 +
shadcn/ui (`base-nova` style, neutral base color, then re-themed) + wagmi v3
/ viem for wallet connection. Sepolia only, `injected()` connector — no
RainbowKit, since a custom button was cheaper than fighting its modal
styling to match the design system.

**Built so far:**
- ABI copied from `contract/out/{RedoubtCoverPool,IERC7984,IPriceOracle}.sol/*.json`
  into `frontend/src/lib/abi/` as a one-time manual copy, not a build step —
  re-copy by hand if the contract changes. Session 17 found
  `RedoubtCoverPool.json` stale (missing session 15/16's constructor params
  and new functions/events) and re-copied it fresh; `IERC7984.json`/
  `IPriceOracle.json` diffed identical to current build output, untouched.
- `frontend/src/lib/contracts.ts`: hardcoded Sepolia addresses, refreshed
  Session 17 (`RedoubtCoverPool` `0x7E880F20B7dD8D307e150b0f59578c4eC20D193A`,
  `MockPriceOracle` `0xb7862C0bD3992CF66aAAe3cD6187adc072263bc4`,
  premiumToken `cUSDCMock` `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`,
  unchanged from Session 10). This is a fresh instance of the session
  15/16-hardened contract — `status()==0` (Active), `currentEpoch()==0` —
  replacing Session 10's pool, which had already reached `Settled` and
  predated the current constructor signature. Session 18 built a
  `buyCover` UI against this address (see below); still no live *claim*
  demo run against it, and no real browser/wallet round-trip has been
  executed against it in this sandbox at all (see session 18's
  verification note).
- `frontend/src/lib/timing.ts`: Session 10's measured, asymmetric
  KMS/relayer timing (encrypted input creation ~28-50s, public decrypt
  ~3.3-3.6s) captured now as named tiers (`read`/`decrypt`/`encryptedInput`)
  so future buyCover/finalize* loading states share one vocabulary instead
  of each guessing independently. Not exercised yet — this session's reads
  are plain `eth_call`s, not FHE decryption.
- Wallet connect (`components/redoubt/connect-wallet.tsx`) + network gate
  (`components/redoubt/network-gate.tsx`): connect, show address, block
  with a "switch chain" action on anything but Sepolia.
- Read-only pool status screen (`components/redoubt/pool-status-card.tsx`):
  `status()` / `currentEpoch()` / `publicReserves()` off
  `RedoubtCoverPool`, `decimals()` / `symbol()` off the premium token for
  display formatting, batched via `useReadContracts`. All plain public
  reads — no FHE/decrypt flow touched.
- Design system: dark-only "case file" theme (fortress-dossier, deliberately
  not a generic near-black+neon or cream+serif default) — brass accent
  `#c1863f`, `PoolStatus` colors kept semantically separate from the brand
  accent (`--status-active`/`--status-claim`/`--status-settled`), a
  corner-bracket frame (`case-file-frame.tsx`) evoking a redoubt's bastion
  corners, a stamped `StatusStamp` badge. Fonts: Source Serif 4 (headings),
  IBM Plex Mono (all data/addresses/numbers), Inter (UI chrome).

**Explicitly NOT built session 11 — each needs its own session per §12:**
- `buyCover` (encrypted input construction via `@zama-fhe/relayer-sdk`,
  the ~28-50s client-side encrypt step) — **built session 18, see below.**
- EIP-712 user-decrypt flow (a policyholder viewing their own coverage) —
  still open, targeted for session 19.
- `claim` — still open.

**Session 12 — marketing/pitch page at the root route:**

- **Routing change:** session 11's read-only status screen moved from `/`
  to `/app` (`frontend/src/app/app/page.tsx`, same wallet-connect/network-gate/
  pool-status-card logic, untouched). `frontend/src/app/page.tsx` is now a
  new, separate marketing page — pitch mode, not utility mode. No new routes
  beyond these two.
- **New dependency: `gsap` + `@gsap/react`.** Added for scroll reveals
  (`ScrollTrigger`) and the solvency-check interaction below. Nothing else
  new — no 3D/WebGL library. Explicitly considered React Three Fiber (the
  3d-web-experience skill was consulted per this session's brief) and
  rejected it: the case-file aesthetic is flat/paper by design, and the one
  thing worth animating (encrypted-in/one-bit-out) reads more clearly as an
  SVG/DOM diagram than a 3D scene would.
- **Content is pulled verbatim from this file** — §1's one-sentence pitch as
  the hero headline, §3's ZK/trusted-server/FHE argument as a three-card
  comparison, §4's three-part mechanism, §6's leakage table reproduced
  exactly (including the UNSOLVED bracketing problem, not softened), and
  §2's rejected alternatives as a compact "case log" strip. No invented
  stats or testimonials.
- **Signature element:** `components/marketing/solvency-diagram.tsx` — an
  interactive, replayable animation of `checkSolvency()`: redacted
  (blacked-out) encrypted inputs merge into an `FHE.le(...)` seal, and only
  a stamped `solvent: false` boolean ever resolves. The caption cites
  Session 10's real Sepolia numbers (300 USDC liabilities vs. 15 USDC
  reserves) rather than an invented example.
- **New components**, all under `frontend/src/components/marketing/`:
  `marketing-header`, `hero-section`, `why-fhe-section`, `mechanism-section`,
  `solvency-diagram`, `leakage-table`, `alternatives-strip`, `closing-cta`,
  plus two shared atoms — `reveal-section` (the one scroll-reveal used
  everywhere, via `useGSAP` + `matchMedia("prefers-reduced-motion")` so it's
  a no-op for reduced-motion users) and `redacted-bar` (the blacked-out-line
  visual standing in for an encrypted value, reused in the hero file mockup
  and the solvency diagram). Reuses `case-file-frame.tsx`/`data-row.tsx`
  from `components/redoubt/` as-is — no second visual language introduced.
- **Footer links are derived, not typed by hand:** the Etherscan URL is
  built from `REDOUBT_CHAIN.blockExplorers.default.url` (viem's `sepolia`
  chain object) + the existing `CONTRACTS` addresses from `contracts.ts`,
  so a wrong network or a typo'd address can't silently drift from what
  `/app` actually reads.
- **Base UI gotcha hit and fixed:** `Button`'s `render` prop defaults to
  assuming the replacement element is a native `<button>`
  (`nativeButton: true`); pointing it at a `next/link` `<Link>` or an `<a>`
  without also passing `nativeButton={false}` throws a console warning on
  every render. Every CTA button on this page passes it explicitly.
- **Lint gotcha:** `eslint-plugin-react-hooks`'s newer `react-hooks/refs`
  rule flags `tlRef.current` reads inside a `@gsap/react` `contextSafe(...)`
  callback as a possible during-render ref read — it can't see through
  `contextSafe`'s deferred-execution wrapping. Suppressed with a targeted
  `eslint-disable-next-line` and a comment, not a blanket rule disable.

**Session 18 — `buyCover` flow, the app's first real encrypted write:**

- **New dependency: `@zama-fhe/relayer-sdk@0.4.4`.** Installed fresh in
  `frontend/` (independently re-confirmed Node 20.19.4 compat rather than
  assuming session 10's Node-script finding still held for a browser
  install — same outcome, `EBADENGINE` warning only).
- **New `frontend/src/lib/fhevm.ts`** — a `getFhevmInstance(provider)`
  singleton wrapping the browser SDK (`@zama-fhe/relayer-sdk/web`, not
  `/node` — the package has no root `.` export). Calls `initSDK()`
  (WASM + `wasm-bindgen-rayon` worker-pool load) exactly once, then
  `createInstance({...SepoliaConfig, network: provider})`. This
  `initSDK()` step is genuinely new versus session 10 — the Node build
  session 10 used has no such export and initializes synchronously via
  native bindings instead. Caches per-provider identity and clears the
  cache on failure so one transient error can't wedge every future
  attempt behind a permanently-rejected cached promise.
- **New `frontend/src/components/redoubt/buy-cover-card.tsx`**, wired
  into `/app` below `PoolStatusCard`. Three real design decisions worth
  keeping straight for the next session:
  1. Operator grant (`isOperator`/`setOperator` on the premium token) is
     its own gated UI step, read from real on-chain state — never assumed
     already done out of band, unlike session 10's own scratch scripts
     which ran `setOperator` unconditionally for a one-off test wallet.
  2. The FHEVM instance is pre-warmed as soon as a wallet connects on
     Sepolia (session 10's ~10s one-time cost), so only the genuinely
     per-call ~28-50s `encrypt()` cost is paid at submit time, surfaced
     via `timing.ts`'s previously-unused `TIMING_TIER.encryptedInput`
     with a live elapsed-seconds counter rather than a bare spinner.
  3. `network` is sourced from wagmi's `connector.getProvider()`, not
     `window.ethereum` directly — more correct under multi-wallet/EIP-6963
     conditions, and something session 10's Node scripts never had to
     consider at all (no browser wallet existed there).
- **Post-purchase state** reads the public `policies(address)` mapping
  (`epochBought`/`claimed` are plaintext struct fields even though
  `coverage` itself is an encrypted handle) to show "open policy, bought
  epoch N" — no decrypt step, deliberately deferring the real EIP-712
  user-decrypt of the coverage amount to session 19.
- **Verification and its real limit:** `npx tsc --noEmit` and
  `npm run build` both clean (see §0's session 18 entry for the exact
  build outcome). No live wallet/relayer/on-chain round-trip was run
  against the session 17 deployment in this sandbox — no injected-wallet
  browser is available here, the same limitation session 17 already
  documented. This is a real, stated gap, not a claim of an end-to-end
  test that didn't happen.

**Sessions 19-21 — landed in the tree with no §15 writeup at the time,
discovered and reconstructed this session (session 22) the same way
session 16 once found undocumented work already sitting in the tree.
Unlike session 16's discovery, no session log or commit trail exists for
these three — the summary below is reconstructed purely from in-code
comments (`grep -n "session 1[9]\|session 2[01]"` across `frontend/src`)
and cross-checked against what the files actually do, not from anyone's
account of what happened. Treat the code as the source of truth over
these session-number attributions; they're best-effort, not authoritative:**

- **Session 19 (inferred): the EIP-712 user-decrypt flow, §12's other
  remaining item besides `claim()`.** `components/redoubt/my-coverage-card.tsx`
  — a policyholder decrypts their own `Policy.coverage` handle via a signed
  EIP-712 authorization (`instance.userDecrypt(...)`, not the public,
  no-signature `publicDecrypt(...)` every `finalize*` function uses).
  `lib/fhevm.ts` gained `userDecryptEuint64`, including the real gotcha:
  the SDK's own `createEIP712(...)` ships `startTimestamp`/`durationDays` as
  decimal strings even though both are EIP-712 `uint256` fields, and viem's
  signer needs an actual `bigint` there, not the string — confirmed against
  a real relayer round-trip (`contract/relayer-scripts/08_verify_viem_signature.js`).
  `lib/timing.ts` gained a fourth tier, `userDecrypt` (~4.3s, distinct from
  `decrypt`'s ~3.3-3.6s: userDecrypt's relayer round trip carries an extra
  signature-authorization check `publicDecrypt` never does), backed by four
  real measured Sepolia calls (4549/4952/3837/3707ms). Reference scripts
  `06_user_decrypt.js`/`07_user_decrypt_timing_only.js` in
  `contract/relayer-scripts/` are this session's own scratch verification,
  same role as session 10's original harness.
- **Session 20 (inferred): the shared "operation HUD" visual, generalized
  out of session 18's `buyCover` loading state.** `components/redoubt/crypto-process/`
  (`OperationHud`, `DecoderText`, `format-elapsed`, `use-reduced-motion`) —
  a floating circular badge, centered over the viewport, that every
  async FHE-relayer chain in this app now pops up for the duration of its
  real phase transitions (never implying progress the SDK doesn't actually
  report). `buy-cover-card.tsx`'s own comment ("see CLAUDE.md session
  18/20") is the direct evidence this session touched that file specifically
  to add `ENCRYPT_STAGE_LABELS`, the heuristic pacing cue through encrypt's
  three real named sub-steps. `app/dev-seal-test/page.tsx` — an
  unlinked scratch route for iterating on `OperationHud`'s visuals in
  isolation (a static log array, a "cycle" button), left in the tree as a
  dev tool, not part of the real app flow.
- **Session 21 (inferred): test funds + shared user-decrypt helper reuse.**
  `components/redoubt/get-funds-card.tsx` — mint the permissionless
  `USDCMock` faucet, approve + `wrap()` it into `cUSDCMock`, and decrypt the
  resulting confidential balance via the SAME `userDecryptEuint64` helper
  session 19 built for the pool's coverage handle (its own comment: "extracted
  ... so a second ciphertext ... doesn't need its own copy of this SDK-quirk
  logic"). `contracts.ts` gained `underlyingToken`, confirmed via the
  wrapper's own `underlying()` getter plus independent bytecode/Etherscan
  verification, not copied from session 10's old scratch-script config on
  faith — this session's own version of session 10's original "verify
  on-chain rather than trust a doc" discipline.
- **What this means going forward:** the actual frontend is three sessions
  ahead of what this file said before today. Before trusting this file's
  own "still open" claims about the frontend, grep `frontend/src` first —
  this is now the second time (after session 16) this project has caught
  its own documentation lagging real progress.

**Session 22 — `claim()` UI: the final piece of the core buyCover → view
coverage → claim loop.**

- **Confirmed against the live contract before wiring anything, per this
  session's own working agreement** (not assumed from this file's prose,
  which for once turned out to match exactly): `claim()` gates on
  `status == ClaimWindowOpen`, `FHE.isInitialized(policy.coverage)`,
  `!policy.claimed`, `currentEpoch >= policy.epochBought + MIN_HOLDING_EPOCHS`
  (§0 session 13/14, `MIN_HOLDING_EPOCHS = 1`, read from the contract as a
  constant rather than hardcoded in the UI), and `!claimDecryptionPending[holder]`.
  All plain public getters — `status()`, `currentEpoch()`,
  `policies(address)`, `claimDecryptionPending(address)`,
  `pendingClaimResult(address)`, `MIN_HOLDING_EPOCHS()`.
- **A real gap found and designed around, not papered over:**
  `policies(holder).claimed` is set to `true` on BOTH a successful
  `finalizeClaim` (paid) AND `abandonStuckClaim` (§0 session 16, foreclosed)
  — the flag alone cannot tell those two outcomes apart. The disambiguator
  is event history: `ClaimPaid(holder, epoch)` fires only on the success
  path, `ClaimDecryptionAbandoned(holder)` only on the foreclosure path.
  `claim-card.tsx` scans both via `publicClient.getContractEvents(...)`
  filtered by `holder`, from `REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK` (new in
  `contracts.ts`: `11207403`, read directly off
  `contract/broadcast/DeployRedoubtCoverPool.s.sol/11155111/run-latest.json`,
  not guessed) rather than genesis. **Worse gap, stated plainly rather than
  worked around:** `finalizeClaim` emits NO event at all when `fullyPaid`
  resolves `false` — unlike the other finalize* functions' withhold
  branches, which all emit something (`PremiumEpochWithheld`,
  `SolvencyChecked(false)`). So "resolved false, retriable" and "never
  attempted" are genuinely indistinguishable on-chain after a page reload —
  there is no event, no flag, nothing persisted for that specific outcome.
  The UI does NOT fake persistence here: a "your last attempt didn't pay in
  full, retriable" banner only ever reflects what THIS browser session just
  watched happen (plain `useState`, cleared on reload/address change), and
  the default unclaimed state uses neutral copy rather than a false claim
  of certainty about any past attempt. Confirmed this is a genuine contract
  property, not a frontend oversight, by re-reading `finalizeClaim`'s
  `if (fullyPaid) { ... }` branch directly — there is no `else`.
- **Two-transaction sequence, resumable across reload — the SAME
  KMS-proof-pull category as `checkSolvency`/`settleEpoch`'s finalize step,
  NOT the same SDK call as session 19's coverage-viewing decrypt** (a real
  distinction worth keeping straight for the next session, since both
  visually use the same `OperationHud`): `claim()` takes no arguments, so
  unlike `buyCover` there is no client-side encrypt step at all. Once mined,
  `pendingClaimResult(holder)` holds an `ebool` handle marked via
  `FHE.makePubliclyDecryptable` — decrypted with `instance.publicDecrypt(...)`
  (no EIP-712 signature, no wallet prompt), NOT `instance.userDecrypt(...)`
  (session 19's signed, private-to-caller path). `lib/fhevm.ts` gained
  `publicDecryptBool`, deliberately mirroring
  `contract/relayer-scripts/04_claims.js`'s own `publicDecryptOne` +
  cleartext-coercion byte-for-byte, including reading the result back via
  `Object.keys(res.clearValues)[0]` rather than indexing by the handle
  string directly — that script is the only place this exact SDK response
  shape has been proven against the real relayer, so its defensive lookup
  was reused as-is rather than assumed safe to simplify. Because
  `claimDecryptionPending` is itself on-chain state, a page reload mid-flow
  (after `claim()` mined but before `finalizeClaim()`) is correctly detected
  and offers a "Finalize claim" resume button — this matters concretely
  here, unlike `buyCover`, since `claim()` alone never sets `claimed`;
  only a resolved `finalizeClaim()` does.
- **Leakage discipline (§6):** no plaintext payout amount anywhere in the
  new component — not in the claim-status copy, not in any log line, not
  passed to `finalizeClaim`'s calldata beyond the single `fullyPaid` bit.
  Only three facts are ever shown: whether this wallet has a policy,
  whether it's claim-eligible right now (and if not, why — no window open
  yet vs. window closed vs. holding period), and whether a resolved claim
  paid or didn't. Coverage amount itself stays exclusively behind session
  19's `my-coverage-card.tsx` decrypt flow, not duplicated here.
- **Persistent Etherscan links** on both `claim()` and `finalizeClaim()` via
  the existing `TxConfirmationLink`, same pattern as every other
  tx-producing action in this app.
- **Naming note:** this session's brief referred to an "Evidence Seal"
  component. No component by that literal name exists — the real shared
  piece is `OperationHud` (`components/redoubt/crypto-process/`). The name
  isn't baseless, though: `app/dev-seal-test/page.tsx` (session 20,
  inferred) is an unlinked scratch route for iterating on `OperationHud`'s
  visuals, and its route name is the only place "seal" appears in this
  codebase. Flagged here so a future session doesn't go looking for a
  component that was never actually built under that name.
- **Explicitly out of scope, per this session's brief:** no UI for
  `settleEpoch`/`checkSolvency`/`triggerClaimWindow`/`settleClaimWindow`/
  `abandonStuck*` — permissionless but pool-admin-adjacent, not aimed at an
  ordinary policyholder. No `RedoubtCoverPool.sol` changes.
- **Verification and its real limit:** `npx tsc --noEmit` clean. `npm run lint`
  clean for every new/changed file (one pre-existing unrelated error in
  `get-funds-card.tsx`, not touched this session, not introduced here).
  `npm run build` was NOT run to completion this session — a stale `next build`
  process from an earlier session had been hung for 42+ minutes holding the
  build lock, and after clearing it the user asked to defer the full build
  verification rather than continue chasing the dev-server/port state in
  their terminal. Stated plainly as a real, currently-open verification gap,
  not implied as tested: run `npm run build` before treating this session's
  work as production-clean. No live wallet/relayer/on-chain round-trip was
  run against the session 17 deployment in this sandbox either, the same
  standing limitation every frontend session since 17 has documented.

**Session 23 — `/admin` page: pool-lifecycle actions that aren't aimed at
an ordinary policyholder (`settleEpoch`/`checkSolvency`/
`triggerClaimWindow`/`settleClaimWindow`/`abandonStuck*`), plus oracle
price control.**

- **Ownership model, confirmed by reading both contracts directly before
  designing any gating (per this session's working agreement), not
  assumed from this file's own prose:** `RedoubtCoverPool.sol` has **no
  owner, no access-control modifier anywhere** beyond `nonReentrant` —
  every function this page exposes is genuinely permissionless, callable
  by any address directly against the contract, exactly as this file has
  repeatedly stated. `MockPriceOracle.sol` is the one piece with real
  on-chain gating: `address public immutable owner` (set to `msg.sender`
  in its constructor), checked in `setPrice`. So this "admin" page is,
  precisely, **the one wallet that happens to control the mock oracle**
  — not a privileged role on the pool. The entire route is gated on
  `mockPriceOracle.owner() == connectedAddress` (`owner-gate.tsx`): for
  oracle price control that gate mirrors a real on-chain restriction; for
  every pool lifecycle/abandon action it is organizational only. UI copy
  states this distinction explicitly in three places (the page header,
  the not-authorized panel, and `oracle-price-card.tsx`'s own caption) —
  deliberately not implying the pool itself has an admin role anywhere.
- **New route:** `frontend/src/app/admin/page.tsx`. Originally built
  unlinked (no changes to any existing page, per this session's initial
  scope boundary), then linked from `/app`'s header with a small "Admin"
  text link at the user's explicit follow-up request — reasoned as safe
  to add despite that boundary because `OwnerGate` already makes visiting
  harmless for anyone who isn't the oracle owner (they just see the
  not-authorized panel). Not linked from the marketing page. Same
  header/layout shell as `/app`'s existing page.
- **`owner-gate.tsx`** wraps children entirely rather than passing an
  `isOwner` flag down — an unauthorized visitor gets zero rendered forms
  or buttons, not just disabled ones, satisfying "should not be able to
  submit any transaction from this route even if they navigate to it
  directly." Client-side only, stated as such in its own not-authorized
  copy: every pool action below remains callable by anyone directly
  against the contract regardless of this page's gate.
- **`lib/abi/MockPriceOracle.json`** (new) and `lib/fhevm.ts`'s new
  `publicDecryptUint` export (alongside the existing `publicDecryptBool`,
  untouched) — needed because `finalizeParticipantCount`/
  `finalizePremiumSettlement` decrypt numbers (a `euint32` count, a
  `euint64` premium total), not bits, so the claim-flow's boolean decrypt
  helper doesn't fit both shapes.
- **`epoch-settlement-card.tsx`** derives which of the four pipeline
  stages (`settleEpoch` → `finalizeParticipantCount` →
  `finalizePremiumValueCheck` → `finalizePremiumSettlement`) is currently
  live purely from on-chain pending flags — resumable across reload, same
  principle as `claim-card.tsx`'s own pending/handle reads. One button
  advances exactly one stage per click (real relayer round trips stay
  distinct, observable steps, not auto-chained); the danger-zone
  `abandonStuckSettlement()` subsection is co-located in the same card
  rather than split out, since it reads the identical pending state, and
  its copy states the stage-1/2-vs-stage-3 asymmetry from session 16
  verbatim (stage 3 only stops the pool from formalizing an
  already-publicly-decryptable total into reserves — it does not
  un-reveal anything).
- **`solvency-check-card.tsx`** surfaces session 15's once-per-epoch rate
  limit directly (comparing `lastSolvencyCheckEpoch` against
  `currentEpoch`) so the button disables instead of letting the
  transaction revert blind, and scans the unindexed, pool-wide
  `SolvencyChecked` event from `REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK` (the
  same source `claim-card.tsx` already uses) to show the last recorded
  result across reloads — otherwise that bit is only ever visible in the
  single browser session that requested it. Its own `abandonStuckSolvencyCheck()`
  danger zone is co-located the same way as the settlement card's.
- **`claim-window-card.tsx`** handles both of the pool's irreversible
  phase transitions (`triggerClaimWindow`/`settleClaimWindow`, §5: no path
  back to `Active`) — neither involves FHE/decryption, both just preview
  eligibility against plain public facts before submission.
- **`abandon-claim-card.tsx`** is deliberately a standalone tool, not
  folded into another card — an operator needs to unstick an *arbitrary*
  holder's claim, not "my own," so it takes an address input and reuses
  `claim-card.tsx`'s exact `ClaimPaid`/`ClaimDecryptionAbandoned`
  event-scan-by-holder pattern to show that holder's outcome before
  acting. Requires an explicit two-step confirm (a "review consequence"
  step before the real submit button) stating session 16's tradeoff
  verbatim: `abandonStuckClaim` **forecloses** the claim permanently, it
  does **not** recover the holder's entitlement, and a holder whose stuck
  attempt actually transferred nothing is wrongly locked out — a
  deliberate conservative bias against double-payment, not a bug.
- **A real lint finding, not incidental:** every card originally computed
  `nowSec` via a direct `Date.now()` call in the component body, to
  compare against on-chain deadlines (epoch end, `decryptionTimeout`
  eligibility, claim-window close). This tripped `react-hooks/purity`
  (calling an impure function during render) — the same category of
  gotcha as session 12's `react-hooks/refs` finding, just a different
  rule. Fixed once, shared: `components/redoubt/admin/use-now-seconds.ts`
  ticks a `bigint | undefined` via a plain `setInterval` inside a
  `useEffect` (mirroring `buy-cover-card.tsx`'s own `elapsedMs` pattern),
  never calling `Date.now()` during render; every admin card imports it
  instead of computing its own. A second, smaller instance of the same
  category: `abandon-claim-card.tsx`'s address-lookup effect originally
  reset two counters synchronously at the top of the effect body before
  its async branch, tripping `react-hooks/set-state-in-effect` — moved
  that reset into the input's own `onChange` handler instead, since an
  event handler (not an effect body) is the correct place for it.
- **Verification and its real limit:** `npx tsc --noEmit` and `npx eslint`
  clean on every new/changed file. `npm run build` was NOT run, per
  current instruction to defer it. No live wallet/relayer/on-chain
  round-trip was run in this sandbox — the same standing limitation every
  frontend session since 17 has documented, and arguably more relevant
  here than usual: none of this session's five cards' write paths
  (`setPrice`, the four-stage settlement pipeline, `checkSolvency`,
  `triggerClaimWindow`/`settleClaimWindow`, the three `abandonStuck*`
  calls) have been exercised against a real wallet or the real relayer.
  Type-checking and lint verify code correctness, not that these flows
  actually work end to end.
- **Explicitly out of scope, per this session's brief:** no changes to
  `/app` or the marketing page, no `RedoubtCoverPool.sol`/
  `MockPriceOracle.sol` changes, no new access-control added to either
  contract — the gating here is frontend-only, for organizational
  clarity, not a real security boundary.
- **Follow-up refinements, same session, user-directed:** (1) `/app`'s
  "Admin" link is a real `Button` (`render={<Link .../>}
  nativeButton={false}`, the established pattern from the marketing
  page's own CTAs — see this doc's earlier Base UI gotcha note), not a
  bare text link, so it reads as an action rather than incidental copy.
  (2) `/admin`'s five cards moved from one long vertical stack into a
  `grid grid-cols-1 md:grid-cols-2` layout (single column on mobile),
  paired Oracle Price + Claim Window and Epoch Settlement + Solvency
  Check as peer-sized cards, `AbandonClaimCard` spanning both columns
  since it's a distinct lookup tool; page container widened to
  `max-w-6xl` to give two columns room. (3) New
  `admin/format-time.ts` (`formatAbsolute`/`formatDuration`/
  `formatRelative`/`formatDeadline`) replaced every raw `unix
  1735689600`-style timestamp and bare-second duration across all five
  admin cards with browser-local absolute time plus a relative form
  (`7/6/2026, 3:42:10 PM (in 4h 12m)`), and humanized durations like
  oracle age / `maxOracleStaleness` (`3m 49s` instead of `229s`) —
  display-only, no ABI/read/write path touched. (4) A real gap in
  `buy-cover-card.tsx` (session 18, untouched until now): it never read
  pool `status` at all, so a new buyer arriving after
  `triggerClaimWindow` still saw a live operator-grant/buy-cover form
  that would revert on submit (§5: `buyCover` requires
  `PoolStatus.Active`, no path back once a claim window has opened).
  Added a `status` read and a `poolAcceptingNewCover` gate: when false
  and the wallet has no existing policy, the form is replaced with an
  explicit "no longer accepting new coverage" message instead of a
  button that would just fail. Deliberately left the existing
  `hasOpenPolicy` branch (an already-covered wallet viewing its policy)
  untouched — that branch was already informational only, no submit
  button, no revert risk.

**Session 24 — `claim-window-card.tsx`: confirmation warning before
`triggerClaimWindow()`, UI-only, no contract changes.**

- **The gap, caught from a real test run, not theorized:** `triggerClaimWindow()`
  submitted with zero warning that it permanently ends the pool's `Active`
  phase (§5: no path back). Since `buyCover`/`settleEpoch()` are both gated
  on `status == Active` (§9), any policy whose `epochBought` hasn't already
  cleared `MIN_HOLDING_EPOCHS` becomes permanently unclaimable the moment
  the window opens — and if the current epoch had already ended without a
  `settleEpoch()` call, that epoch's premium total is stuck unsettled
  forever too. This had already happened once, live, before this session.
- **Fix, matching `abandon-claim-card.tsx`'s existing two-step
  review-then-confirm shape rather than inventing a new pattern:** the
  plain `triggerClaimWindow()` button became "Review consequence"; clicking
  it expands a destructive `Alert` in place (not a modal — same inline
  pattern the abandon card already uses) stating plainly that the
  transition is permanent and that `buyCover`/`settleEpoch()` can never be
  called again, plus the pool's current `currentEpoch()` value with the
  explicit "any policy bought in epoch N will never become claimable"
  statement — shown unconditionally, not gated on any per-holder scan.
- **Settle-first detection reuses `epoch-settlement-card.tsx`'s own
  `settleEpochEligible` shape verbatim** (`epochStartTimestamp +
  epochLength` vs. now, while `status == Active`) rather than a new
  time-math idiom — three new reads (`currentEpoch`, `epochStartTimestamp`,
  `epochLength`) added to the card's existing `useReadContracts` call.
  When true, an additional warning line appears with a same-page anchor
  link (`epoch-settlement-card.tsx`'s outer `Card` gained `id="epoch-settlement"`
  and `scroll-mt-6`) down to the Epoch Settlement section, and the confirm
  button is gated behind an extra required checkbox ("I understand any
  pending policy from this epoch will become permanently unclaimable") —
  a stricter bar than the unconditional case, which only needs the expand
  step itself before the real submit button enables. Confirm/cancel state
  resets on a successful trigger.
- **Verification:** `npx tsc --noEmit` clean. `npm run build` run this
  session (see build output for pass/fail — not folded into this entry
  since it was still running at write time).
- **Explicitly out of scope, per this session's brief:** no
  `RedoubtCoverPool.sol` changes, no change to `triggerClaimWindow`'s
  actual on-chain behavior or eligibility — this only surfaces the
  irreversible consequence and the correct operational order before the
  user acts; the action itself remains permissionless and unblocked.