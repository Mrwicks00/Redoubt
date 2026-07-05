# Redoubt

A single-peril confidential insurance pool where coverage amounts, premiums, and payouts are encrypted end to end (ERC-7984 + FHEVM euint64), and the pool proves it can pay every claim by comparing encrypted total liabilities against public reserves — without ever revealing what any individual is owed.

Built on Zama's FHEVM.

## Why FHE, not ZK

Solvency is a **joint computation over every policyholder's secret**. A ZK proof lets one user prove a fact about their own input — it cannot prove an aggregate fact ("the sum of everyone's coverage is within reserves") without someone first collecting all the plaintext inputs. A trusted server that could see everyone's coverage recreates the exact surveillance problem the protocol exists to solve: **buying cover in plaintext announces what you're afraid of losing**, which is itself exploitable information (a $2M depeg-cover purchase reveals a $2M position in that asset).

FHE isn't used here because it's novel — it's used because the alternative (plaintext coverage amounts) is a direct information leak with no mitigation.

## Mechanism

1. **Blind underwriting.** `buyCover` takes an encrypted coverage amount (`externalEuint64` + a ZK proof of well-formedness, FHEVM's standard external-input pattern). Premium = `coverage * rateBps / 10_000`, computed homomorphically — division here is by a plaintext constant (`10_000`), which `FHE.div` supports. Ciphertext-to-ciphertext division is not supported by FHEVM and is never used anywhere in this codebase.
2. **Encrypted solvency proof.** The pool keeps a running encrypted sum of all liabilities (`totalLiabilities`). `checkSolvency` does a single `FHE.le(totalLiabilities, publicReserves)` and requests decryption of **only the resulting bit** — "solvent: true/false" — never any underlying amount.
3. **Leakage-resistant claims.** Claims can only open after a **public, undeniable** oracle event (price crossing `depegThreshold`). Payout amounts remain encrypted ERC-7984 transfers, settled per epoch, not immediately per-claim.

## Why this project, not the alternatives

Evaluated against five other ideas for Zama's Season 3 Developer Program. Two finalists stood out; Redoubt was chosen over the other for a narrow, deliberate reason:

- **Netting batcher** (MEV-blind execution via encrypted order aggregation) was rejected — its privacy guarantee is effectively zero below ~10 concurrent participants, and it competes against free incumbents (Flashbots Protect, private mempools). Its core lesson still shapes Redoubt directly: no public event should correspond to exactly one person's secret, which is why premiums and claims are batched by epoch instead of settled immediately.
- **Confidential lending** (liquidation-by-boolean) was the other finalist, and a strong one — but the ecosystem's own commercial activity (GSR/Zama OTC trade, institutional dark-pool narrative) is already headed there. Redoubt won out for having a cleaner "why FHE, not ZK" argument and an empty competitive lane.

## Leakage model

This is not a fully private system. Every leak is documented here on purpose — this table is meant to prove the threat model was understood, not to make the project look more finished than it is.

| Event | Visible | Hidden | Residual risk |
|---|---|---|---|
| `buyCover` | that an address bought cover, in which epoch | coverage amount, premium amount | timing correlation if very few buyers in an epoch |
| `settleEpoch` | epoch's **total** premiums once decrypted | each buyer's individual premium | thin epochs, both by headcount (MIN_EPOCH_PARTICIPANTS) and by value (minEpochPremiumTotal, session 15) — see guards below |
| `checkSolvency` | one bit: solvent true/false | total liabilities, reserve composition | **MITIGATED, not solved (session 15)**: rate-limited to once per epoch, so one buy/claim can no longer be bracketed within a single epoch — a patient attacker checking once per epoch over many epochs can still attempt slower, noisier inference via the reserve delta trend |
| `claim` | that an address claimed | payout amount (still ERC-7984 encrypted) | claim timing correlates with known public depeg time; mitigated by batched claim windows |

**Guard implemented:** `MIN_EPOCH_PARTICIPANTS` (3) withholds premium decryption entirely if fewer than 3 policies were bought in an epoch — the pending amount rolls into the next epoch instead of settling. An aggregate of one or two participants isn't an aggregate, it's a leak with extra steps.

**Guard implemented, session 15:** `minEpochPremiumTotal` (immutable constructor param, not a hardcoded constant — a token/market-specific value can't be a protocol-wide constant the way `MIN_EPOCH_PARTICIPANTS` is) withholds premium decryption if the epoch's real total is too low, even when headcount clears `MIN_EPOCH_PARTICIPANTS`. Checked via a still-encrypted `FHE.ge` comparison, with only the resulting bit (not the total) marked decryptable in an intermediate `finalizePremiumValueCheck` stage — decrypting the real total first and withholding after the fact would already have leaked it off-chain regardless of the contract's own decision. **What this does not do:** it raises the cost of padding with many tiny/dust payments specifically; it does not stop a well-funded attacker from padding headcount with several moderately-sized real payments instead — that still clears both guards. Headcount-only sybil padding remains open.

**Mitigated, session 15 (previously a fully open problem):** repeated `checkSolvency` calls immediately before/after a single `buyCover` used to let an observer bracket that buyer's coverage via the reserve delta between two solvency snapshots. `checkSolvency()` is now rate-limited to at most once per `currentEpoch`. **What this closes:** an attacker can no longer sandwich a single `buyCover` between two solvency checks within the same epoch. **What this does NOT close:** an attacker checking once at the start and once at the end of every epoch, over many epochs, watching the reserve delta trend over time, could still attempt slower, noisier inference — harder and slower now, not impossible.

## Deployed contracts (Sepolia)

| Contract | Address |
|---|---|
| `RedoubtCoverPool` | [`0x7E880F20B7dD8D307e150b0f59578c4eC20D193A`](https://sepolia.etherscan.io/address/0x7E880F20B7dD8D307e150b0f59578c4eC20D193A) |
| `MockPriceOracle` | [`0xb7862C0bD3992CF66aAAe3cD6187adc072263bc4`](https://sepolia.etherscan.io/address/0xb7862C0bD3992CF66aAAe3cD6187adc072263bc4) |
| `premiumToken` (`cUSDCMock`, Zama Wrappers Registry pair) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |

Both `RedoubtCoverPool` and `MockPriceOracle` are verified on Etherscan. `cUSDCMock` is a real registered pair from Zama's Confidential Token Wrappers Registry (underlying `USDCMock`, permissionless `mint`), not a self-deployed placeholder token.

Epoch length and claim-window duration on this deployment are 300 seconds each — **demo-scale, not a production recommendation** — chosen short enough to observe real on-chain deadlines elapse in wall-clock time.

## Setup & running

### Contracts (`contract/`)

Requires [Foundry](https://book.getfoundry.sh/) with `zama-ai/forge-fhevm` as a dependency. `lib/forge-fhevm` and `lib/forge-std` are git submodules — if you cloned without `--recurse-submodules`, fetch them first:

```bash
git submodule update --init --recursive
```

Then:

```bash
cd contract
forge build
forge test
```

To deploy or drive the live pool yourself, copy `.env.example` to `.env` and fill in:

```
SEPOLIA_RPC_URL=       # Alchemy / Infura / dRPC / etc.
PRIVATE_KEY=           # deployer + buyer #1
PRIVATE_KEY_2=         # buyer #2
PRIVATE_KEY_3=         # buyer #3 — MIN_EPOCH_PARTICIPANTS is 3, need three distinct buyers to see PremiumEpochSettled
ETHERSCAN_API_KEY=     # optional, enables forge verify-contract
```

Then:

```bash
forge script script/DeployRedoubtCoverPool.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
```

### Frontend (`frontend/`)

Next.js 16 (App Router) + wagmi + `@zama-fhe/relayer-sdk`, Sepolia only.

```bash
cd frontend
npm install
npm run dev
```

No `.env` is required — contract addresses are hardcoded in `src/lib/contracts.ts` against the Sepolia deployment above. `@zama-fhe/relayer-sdk@0.4.4` declares `engines.node >= 22`; it has been run successfully on Node 20.19.4 (via its CJS/browser subpath exports) with only an `EBADENGINE` warning, but Node 22+ is the environment it actually declares support for.

Connect a Sepolia wallet at `/app` to buy cover, view your own encrypted coverage (EIP-712 user-decrypt), and claim. `/admin` exposes the permissionless pool-lifecycle actions (`settleEpoch`, `checkSolvency`, `triggerClaimWindow`, etc.) plus oracle price control — gated client-side on the mock oracle's owner address, not a real on-chain admin role on the pool itself (the pool has none).

## Limitations & future directions

These are stated as the project's actual boundaries, not a progress tracker — each is either an intentional design tradeoff or an investigated, currently-open gap.

- **Sybil headcount padding.** `minEpochPremiumTotal` closes the cheap/dust variant of padding an epoch's participant count, but a well-funded attacker can still pad `epochParticipantCount` with several moderately-sized *real* payments — that still clears both `MIN_EPOCH_PARTICIPANTS` and `minEpochPremiumTotal`. This general form of sybil headcount padding is a known, currently-open limitation, not something the current guards fully close.

- **Moral hazard — "never held the coin."** `buyCover` has no way to verify the caller actually holds the asset they're insuring. This was investigated directly and found **architecturally blocked**, not merely unbuilt: the obvious fix (comparing coverage against the caller's real token balance inside the pool) requires reading `confidentialBalanceOf`, but that handle carries ACL access only for the token contract and the balance owner — never a third-party contract — and the pool can't self-remedy, since `ACL.allow()` requires the caller already be allowed on a handle before it can extend access to itself. This is a structural property of ERC-7984's ACL model as written, not a missing line of code.

  Given that wall, Redoubt is — by design — a **parametric insurance model**: payout triggers on a public, objective fact (the oracle crossing `depegThreshold`), with no proof-of-loss step. This is the same deliberate tradeoff real-world crop insurance and catastrophe bonds make: speed and simplicity over individually verifying each claimant's actual loss.

  A partial mitigation exists: a minimum holding period (`MIN_HOLDING_EPOCHS = 1`) between buying cover and claim eligibility, which closes the sharpest version of this gap — buying cover in the last few minutes before a *known* depeg on insider information. It does **not** close the general case: someone can still buy cover with zero real exposure, wait out one epoch, and collect a payout if they're eventually right about a depeg with no time pressure to act on inside information.

  The deeper open research direction is bridging FHE ciphertexts with a ZK proof — proving "my real balance ≥ X" without decrypting it and without needing pool-side ACL access at all. This is an open research problem in the current FHE ecosystem, not an available toolchain item today.

- **`checkSolvency` bracketing.** Mitigated (rate-limited to once per `currentEpoch`) but not fully solved. A patient attacker checking once per epoch over many epochs, watching the reserve delta trend, could still attempt slower, noisier inference than the single-epoch bracketing this guard closes.

## Test status

`forge test`: 44/44 passing (43 substantive + 1 skeleton) against forge-fhevm's real host contracts, not a simplified mock.

For the full session-by-session build history and reasoning behind every design decision above, see [CLAUDE.md](./claude.md) and [CLAUDE_HISTORY.md](./CLAUDE_HISTORY.md).
