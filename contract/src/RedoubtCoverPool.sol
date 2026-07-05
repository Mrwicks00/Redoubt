// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint32, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RedoubtCoverPool is ZamaEthereumConfig, ReentrancyGuard {
    enum PoolStatus {
        Active,
        ClaimWindowOpen,
        Settled
    }

    struct Policy {
        euint64 coverage;
        uint256 epochBought;
        bool claimed;
    }

    uint256 public constant MIN_EPOCH_PARTICIPANTS = 3;
    uint256 public constant PREMIUM_RATE_DENOMINATOR = 10_000;
    // §0 session 15 mitigation for the sybil-identity/thin-value gap:
    // MIN_EPOCH_PARTICIPANTS alone only bounds headcount, and many
    // distinct real addresses can each pay a dust premium and still clear
    // it. Unlike MIN_EPOCH_PARTICIPANTS (a pure headcount, dimensionless
    // across any deployment), a meaningful minimum VALUE is inherently
    // token/market-specific -- it depends on the premium token's decimals
    // and what "not worth revealing" means for that asset. That is the
    // same reasoning that already makes depegThreshold a constructor
    // param rather than a hardcoded constant, so minEpochPremiumTotal
    // follows suit below (immutable, not a `uint256 public constant`),
    // deliberately not named in ALL_CAPS the way MIN_EPOCH_PARTICIPANTS
    // is -- that naming difference is intentional, marking it as a
    // per-deployment business parameter, not a protocol-wide constant.
    // §0 session 13's moral-hazard writeup, now built: a minimum holding
    // period between buyCover and claim eligibility. 1 epoch is the
    // smallest value that means anything -- it guarantees at least one
    // epoch boundary (settleEpoch's own natural clock) separates a
    // purchase from any claim against it, closing the sharpest version of
    // "buy cover in the last few minutes before a known depeg on insider
    // knowledge." Deliberately does NOT close the general "never held the
    // coin at all" moral-hazard gap -- see policy.epochBought's check in
    // claim() for the precise scope of what this does and doesn't cover.
    uint256 public constant MIN_HOLDING_EPOCHS = 1;

    IERC7984 public immutable premiumToken;
    uint256 public immutable premiumRateBps;
    uint256 public immutable epochLength;
    IPriceOracle public immutable priceOracle;
    uint64 public immutable depegThreshold;
    // §11 hardening item 3: how long triggerClaimWindow will trust
    // priceOracle.lastUpdated() before treating the price as stale. Depeg
    // events are fast-moving and triggerClaimWindow's effect is
    // irreversible (§5: no path back to Active), so this must be long
    // enough to tolerate normal oracle update cadence/network hiccups but
    // short enough that a stale price can't be weaponized to fake -- or to
    // miss -- a real depeg. Originally a hardcoded constant; moved to a
    // constructor param for the same reason depegThreshold and
    // minEpochPremiumTotal already are one -- a meaningful staleness
    // tolerance is deployment-specific (a 5-minute-epoch demo and a
    // day-scale production pool need very different values), not a
    // protocol-wide constant.
    uint256 public immutable maxOracleStaleness;
    // §0 session 9 design decision: how long after triggerClaimWindow
    // policyholders have to file a claim before the pool moves to
    // Settled. Modeled as a constructor param, not a constant, mirroring
    // epochLength -- this is a pool-specific business parameter (how
    // long a claims process stays open), not a protocol-level security
    // margin like MAX_ORACLE_STALENESS. A fixed duration off a single
    // public timestamp (claimWindowOpenedAt, set once in
    // triggerClaimWindow) was chosen over alternatives considered and
    // rejected: (a) an admin-called "close claims now" function --
    // rejected, no admin role exists anywhere else in this contract and
    // introducing one here just to end the claims process is a bigger
    // architectural change than the problem warrants; (b) closing
    // automatically once every known policy has claimed -- rejected,
    // "every known policy" is an encrypted-population question this
    // contract has no cheap way to answer, and a single non-claiming
    // holder would wedge the pool in ClaimWindowOpen forever, which is
    // the exact bug this session exists to fix. A fixed duration is
    // permissionless, requires no new role, and gives every policyholder
    // a known, public deadline.
    uint256 public immutable claimWindowDuration;
    // §0 session 15: minimum total premiums (in the premium token's own
    // smallest unit) an epoch must clear, IN ADDITION to
    // MIN_EPOCH_PARTICIPANTS, before its total is ever revealed. See the
    // constant block above for why this is an immutable constructor param
    // rather than a hardcoded constant like MIN_EPOCH_PARTICIPANTS.
    uint256 public immutable minEpochPremiumTotal;
    // §11 hardening item 4: how long a pending decryption (settlement
    // pipeline stage, solvency check, or a single claim) may sit
    // unresolved before its corresponding abandon* function may be called
    // to give up on it. FHEVM's pull model means a publicly-decryptable
    // handle never expires -- any finalize* function can still succeed
    // whenever a fresh KMS proof becomes available, no matter how much
    // time has passed -- so ordinary relayer/KMS downtime is already
    // self-healing without this at all. This value only needs to be large
    // enough that it never fires during real, if slow, KMS/relayer
    // activity: session 10's own measured Sepolia latency was ~28-50s for
    // encrypted input creation and a consistent ~3.3-3.6s for public
    // decryption, worst case under a minute. A day-scale value is 1000x+
    // that worst case -- long enough to never trip during any plausible
    // transient outage, short enough that the pool can't be bricked for
    // more than a day by one permanently-lost decryption request (a
    // KMS-side data-loss bug for that specific handle, not mere downtime --
    // see abandonStuckSettlement's comment for what "abandon" does and does
    // not undo). A constructor param, not a constant, for the same
    // deployment-specific reasoning as maxOracleStaleness above.
    uint256 public immutable decryptionTimeout;

    euint64 internal totalLiabilities;
    euint64 internal pendingPremiums;
    uint256 public publicReserves;

    uint256 public currentEpoch;
    uint256 public epochStartTimestamp;
    PoolStatus public status;
    // Set once, in triggerClaimWindow, and never touched again -- the
    // fixed reference point settleClaimWindow measures claimWindowDuration
    // against. Zero (its default) is never a valid "opened" timestamp in
    // practice: triggerClaimWindow can only run at block.timestamp > 0 on
    // any real chain, and settleClaimWindow itself is gated on
    // status == ClaimWindowOpen, which is unreachable before
    // triggerClaimWindow has set this.
    uint256 public claimWindowOpenedAt;

    // Snapshot of a past epoch's pendingPremiums total while its public
    // decryption is in flight. pendingPremiums itself is reset to a fresh
    // encrypted zero the moment settlement is initiated (see settleEpoch),
    // so a buyCover arriving mid-decryption can never fold new premiums
    // into a handle a KMS proof has already been requested for. Public
    // (not internal) so an off-chain relayer -- or a test -- can discover
    // exactly which handle to fetch a decryption proof for.
    euint64 public premiumsAwaitingDecryption;
    // True only once finalizeParticipantCount has confirmed
    // MIN_EPOCH_PARTICIPANTS was met for pendingSettlementEpoch -- NOT set
    // by settleEpoch itself. Ordered after the participant-count guard so
    // the premium total can never become decryptable before the count has
    // cleared the threshold in its own separate step.
    bool public premiumDecryptionPending;
    // §0 session 15: the intermediate stage inserted between
    // finalizeParticipantCount and finalizePremiumSettlement. Checking
    // minEpochPremiumTotal by decrypting the real total first (inside
    // finalizePremiumSettlement) and withholding after the fact would be
    // too late -- makePubliclyDecryptable plus a submitted KMS proof
    // already reveals the real number to anyone off-chain, regardless of
    // what the contract does with it afterward. That is the exact same
    // ordering trap session 8 already avoided for participant-count vs.
    // premium-total (see settleEpoch's comment) -- so the value threshold
    // must be checked as a still-encrypted FHE.ge comparison, with only
    // the resulting BIT (not the total) marked decryptable next, mirroring
    // checkSolvency's own one-bit-reveal pattern.
    ebool public pendingPremiumValueCheck;
    bool public premiumValueCheckPending;
    // Decrypted (plaintext) participant count for the settlement currently
    // sitting in the premium-value-check stage above -- captured in
    // finalizeParticipantCount once the count clears MIN_EPOCH_PARTICIPANTS,
    // purely so finalizePremiumValueCheck can still cite it in
    // PremiumEpochWithheld if the value threshold ends up failing. The
    // count itself was already revealed via finalizeParticipantCount's own
    // calldata; this only carries it one stage forward for the event.
    uint256 public pendingRevealedParticipantCount;
    // Which epoch the settlement pipeline currently in flight concerns.
    // Set once, in settleEpoch, and read by both finalizeParticipantCount
    // and finalizePremiumSettlement -- the two are sequential stages of
    // one pipeline for the same epoch, never for two different epochs at
    // once (settleEpoch's pending-guards below enforce that).
    uint256 public pendingSettlementEpoch;
    // §11 hardening item 4: set once, in settleEpoch(), when the pipeline
    // begins -- NOT reset as it advances through stages. One clock covers
    // the whole pipeline: even three real decrypts back-to-back are only
    // ~10-20s worst case (see decryptionTimeout's comment), negligible
    // next to a day-scale timeout, so there's no need for a separate clock
    // per stage. Cleared to 0 on every terminal outcome -- both withhold
    // branches, the success branch, and abandonStuckSettlement.
    uint256 public settlementPendingSince;

    // Encrypted running counter of successfully-credited policies in the
    // current epoch. euint32 comfortably bounds any realistic epoch's
    // participant count. Snapshotted into
    // participantCountAwaitingDecryption and reset to a fresh encrypted
    // zero the moment settleEpoch() initiates the pipeline, mirroring
    // pendingPremiums' own snapshot/reset pattern exactly.
    euint32 internal epochParticipantCount;
    euint32 public participantCountAwaitingDecryption;
    // True from settleEpoch() until finalizeParticipantCount resolves it
    // (either withholding the epoch or handing off to
    // premiumDecryptionPending above). Deliberately a separate flag from
    // premiumDecryptionPending, not reused: the two guard different
    // stages of the same pipeline, and settleEpoch must refuse to start a
    // new cycle while EITHER stage of a previous one is still
    // unresolved, since both stages read/write the same singleton
    // snapshot handles.
    bool public participantCountDecryptionPending;

    // Same pull-model / discoverable-handle pattern as
    // premiumsAwaitingDecryption above, for the solvency check.
    ebool public pendingSolvencyResult;
    bool public solvencyCheckPending;
    // §0 session 15 mitigation for §6's bracketing leak: the epoch a
    // solvency check was last INITIATED in (set the moment checkSolvency
    // runs, not when it finalizes) -- reusing currentEpoch, the same clock
    // every other epoch-gated check in this contract already uses,
    // instead of a second independent time-based system. This is a
    // separate gate from solvencyCheckPending above: pending means
    // "already in flight," this means "too soon since the last one" --
    // both must hold simultaneously (see checkSolvency).
    uint256 public lastSolvencyCheckEpoch;
    // §11 hardening item 4: set in checkSolvency(), cleared in
    // finalizeSolvencyCheck() and in abandonStuckSolvencyCheck().
    uint256 public solvencyCheckPendingSince;

    // Same pull-model pattern again, for claims -- but per-POLICY
    // (per-address), not a pool-wide singleton like the two guards above.
    // Multiple claimants can legitimately have decryptions in flight
    // simultaneously, unlike settleEpoch/checkSolvency which only ever
    // have one pool-wide operation pending at a time.
    mapping(address holder => bool) public claimDecryptionPending;
    mapping(address holder => ebool) public pendingClaimResult;
    // §11 hardening item 4: set in claim(), cleared in finalizeClaim() and
    // in abandonStuckClaim(holder). Per-holder, mirroring
    // claimDecryptionPending's own per-holder shape.
    mapping(address holder => uint256) public claimPendingSince;

    // "Does this address have a policy" is answered by
    // FHE.isInitialized(policies[holder].coverage) -- the same
    // never-touched-vs-touched distinction ERC7984 uses for balances. No
    // separate plaintext bool: that would conflate "ever attempted" with
    // "has a real paid policy" into one flag. See buyCover for the
    // reasoning.
    mapping(address holder => Policy) public policies;

    event PolicyOpened(address indexed holder, uint256 indexed epoch);
    event PremiumEpochWithheld(uint256 indexed epoch, uint256 participantCount);
    event PremiumEpochSettled(uint256 indexed epoch, uint256 revealedTotal);
    event SolvencyChecked(bool solvent);
    event ClaimWindowTriggered(uint256 indexed epoch, uint64 oraclePrice);
    // Not in §9's literal event list, but §6's leakage table documents
    // "that an address claimed" as the intended visible fact for claim --
    // an amount-free event, consistent with PolicyOpened.
    event ClaimPaid(address indexed holder, uint256 indexed epoch);
    // §9 named this event without ever specifying its trigger (§0 session
    // 9 closes that gap): fired exactly once, by settleClaimWindow, on the
    // ClaimWindowOpen -> Settled transition. Named to mirror
    // PremiumEpochSettled -- both mark a pipeline's terminal, no-more-
    // mutation state, and neither carries anything beyond the epoch
    // number.
    event ClaimEpochSettled(uint256 indexed epoch);
    // §11 hardening item 4: deliberately distinct events from
    // PremiumEpochWithheld/SolvencyChecked/ClaimPaid -- the reason a cycle
    // ended without revealing anything is "timeout," not "below threshold"
    // or "resolved false," and that distinction matters to anyone reading
    // the pool's history. `stage` is 1 (participant count), 2 (premium
    // value check), or 3 (premium total) -- whichever stage was stuck.
    event SettlementDecryptionAbandoned(uint256 indexed epoch, uint8 stage);
    event SolvencyCheckAbandoned();
    event ClaimDecryptionAbandoned(address indexed holder);

    constructor(
        IERC7984 premiumToken_,
        uint256 premiumRateBps_,
        uint256 epochLength_,
        IPriceOracle priceOracle_,
        uint64 depegThreshold_,
        uint256 maxOracleStaleness_,
        uint256 claimWindowDuration_,
        uint256 minEpochPremiumTotal_,
        uint256 decryptionTimeout_
    ) {
        require(premiumRateBps_ <= PREMIUM_RATE_DENOMINATOR, "RedoubtCoverPool: rate exceeds 100%");
        // Must fit euint64 to ever be compared against premiumsAwaitingDecryption
        // (see finalizeParticipantCount's FHE.ge check) -- same precondition
        // checkSolvency already enforces on publicReserves, for the same reason.
        require(minEpochPremiumTotal_ <= type(uint64).max, "RedoubtCoverPool: minEpochPremiumTotal exceeds euint64 range");

        premiumToken = premiumToken_;
        premiumRateBps = premiumRateBps_;
        epochLength = epochLength_;
        priceOracle = priceOracle_;
        depegThreshold = depegThreshold_;
        maxOracleStaleness = maxOracleStaleness_;
        claimWindowDuration = claimWindowDuration_;
        minEpochPremiumTotal = minEpochPremiumTotal_;
        decryptionTimeout = decryptionTimeout_;
        epochStartTimestamp = block.timestamp;
        status = PoolStatus.Active;

        // Sentinel meaning "no solvency check has ever been initiated" --
        // 0 is a real, valid epoch number (currentEpoch starts there), so
        // it can't serve as the "never" sentinel the way claimWindowOpenedAt's
        // 0 default does. type(uint256).max is never a real epoch in
        // practice, same reasoning.
        lastSolvencyCheckEpoch = type(uint256).max;

        totalLiabilities = FHE.asEuint64(0);
        pendingPremiums = FHE.asEuint64(0);
        epochParticipantCount = FHE.asEuint32(0);
        FHE.allowThis(totalLiabilities);
        FHE.allowThis(pendingPremiums);
        FHE.allowThis(epochParticipantCount);
    }

    // Caller must already have granted this contract operator status on
    // `premiumToken` via `premiumToken.setOperator(address(this), until)`
    // -- ERC-7984's operator model, not a per-amount allowance. Unlike a
    // missing FHE ACL grant (silent failure), a missing operator grant
    // reverts loudly with ERC7984UnauthorizedSpender.
    // nonReentrant: the credited amount below can only be computed AFTER
    // confidentialTransferFrom returns, so this function cannot be fully
    // checks-effects-interactions -- some state mutation is unavoidably
    // after the external call (§11's documented reentrancy-guard
    // fallback).
    function buyCover(externalEuint64 encryptedCoverage, bytes calldata proof) external nonReentrant {
        // Single-round pool (§5): once the claim window has opened, the
        // depeg event is already public knowledge, so selling new
        // coverage would mean underwriting a peril known to have already
        // occurred. There is no path back to Active in this design.
        require(status == PoolStatus.Active, "RedoubtCoverPool: not in active phase");

        // No synchronous "already has a policy" gate: a plain
        // `require(!hasPolicy[...])` can't know whether a PRIOR attempt
        // actually succeeded (that's an encrypted fact), and decrypting
        // it just to place one require isn't viable for a function that
        // must stay single-transaction. Instead every call recomputes
        // "is this address already covered" homomorphically from the
        // already-encrypted stored coverage (see shouldCredit below) --
        // no new async step needed.
        Policy storage p = policies[msg.sender];
        // Distinguishes "never called buyCover before" from "has a Policy
        // record already" (coverage may itself be an encrypted zero from
        // a prior failed attempt) -- same distinction ERC7984 makes for
        // balances via FHE.isInitialized. This plaintext branch only
        // picks a default for an intermediate value; it never decides
        // accept/reject based on the encrypted payment outcome.
        euint64 existingCoverage = FHE.isInitialized(p.coverage) ? p.coverage : FHE.asEuint64(0);

        euint64 coverage = FHE.fromExternal(encryptedCoverage, proof);

        // premium = coverage * rateBps / 10_000 -- both operands of `div`
        // are plaintext constants (rateBps as scalar multiplier, then the
        // fixed denominator), never ciphertext/ciphertext division.
        // casting to uint64 is safe: premiumRateBps is bounded to
        // <= PREMIUM_RATE_DENOMINATOR (10_000) in the constructor.
        // forge-lint: disable-next-line(unsafe-typecast)
        euint64 premium = FHE.div(FHE.mul(coverage, uint64(premiumRateBps)), uint64(PREMIUM_RATE_DENOMINATOR));

        // FHE ops auto-grant TRANSIENT access to their result, but only
        // to the contract that computed it, for the rest of the current
        // transaction -- it never extends to a DIFFERENT contract the
        // value is handed to, and doesn't survive past this transaction.
        // premiumToken.confidentialTransferFrom needs its OWN access to
        // `premium` for its internal balance check (performed as the
        // token contract), hence the explicit FHE.allow below.
        FHE.allowThis(premium);
        FHE.allow(premium, address(premiumToken));

        // confidentialTransferFrom does NOT revert on insufficient buyer
        // balance -- ERC-7984's FHESafeMath pattern silently transfers
        // less (in practice, exactly 0) instead of reverting. Capturing
        // and checking the returned `transferred` handle, rather than
        // trusting the caller-supplied `premium` on faith, is the fix.
        euint64 transferred = premiumToken.confidentialTransferFrom(msg.sender, address(this), premium);

        // Only credit what was actually paid: transferred is either
        // premium (success) or less (failure) per FHESafeMath's own
        // success/0 pattern. A synchronous require on this isn't possible
        // -- fullyPaid is an ebool, and decrypting it would mean the full
        // two-transaction pull-model cycle just to place one require, not
        // viable for a call that must stay single-transaction. FHE.select
        // is the only synchronous option, mirroring FHESafeMath itself.
        ebool fullyPaid = FHE.eq(transferred, premium);

        // fullyPaid alone isn't enough to gate a credit: without also
        // checking existingCoverage, a buyer who already has a real,
        // fully-paid policy could call buyCover again and get credited a
        // second time. alreadyCovered is true only once a real (nonzero)
        // coverage amount has actually stuck from a PRIOR call --
        // computed homomorphically, never decrypted.
        ebool alreadyCovered = FHE.gt(existingCoverage, FHE.asEuint64(0));
        // shouldCredit is false whenever the buyer already has a real
        // policy, regardless of whether THIS call's payment succeeded --
        // a redundant successful payment still moves real tokens (see
        // pendingPremiums below) but can never inflate totalLiabilities
        // or overwrite a locked-in coverage amount.
        ebool shouldCredit = FHE.and(fullyPaid, FHE.not(alreadyCovered));
        euint64 creditedCoverage = FHE.select(shouldCredit, coverage, FHE.asEuint64(0));

        // Unavoidably after the external call (see nonReentrant note
        // above): these can only be computed from `transferred`, which
        // doesn't exist until confidentialTransferFrom returns.
        totalLiabilities = FHE.add(totalLiabilities, creditedCoverage);
        // pendingPremiums reflects real tokens actually received,
        // independent of the coverage-crediting gate above -- premium
        // accounting and liability accounting are separate bookkeeping.
        // A buyer who pays again after already being covered still hands
        // the pool real premium; that revenue isn't hidden from
        // publicReserves just because it won't be credited as liability.
        pendingPremiums = FHE.add(pendingPremiums, transferred);
        FHE.allowThis(totalLiabilities);
        FHE.allowThis(pendingPremiums);

        // Sticky: existingCoverage is 0 until the first call that
        // satisfies shouldCredit; every call after that adds 0 on top
        // (creditedCoverage forced 0 by alreadyCovered), so
        // newStoredCoverage never changes again -- the "no second real
        // credit" guarantee, without ever decrypting a payment outcome.
        euint64 newStoredCoverage = FHE.add(existingCoverage, creditedCoverage);
        // claimed is always false here safely: buyCover requires
        // status == Active, and claimed can only become true via
        // finalizeClaim, which requires ClaimWindowOpen -- a state this
        // pool can never return to Active from (§5). epochBought is NOT
        // kept sticky the same way: nothing reads it for access control
        // or solvency, so recording the latest call's epoch (rather than
        // whichever call got credited) is a cosmetic-only inaccuracy.
        policies[msg.sender] = Policy({coverage: newStoredCoverage, epochBought: currentEpoch, claimed: false});
        FHE.allowThis(newStoredCoverage);
        FHE.allow(newStoredCoverage, msg.sender);

        // Increment the encrypted participant counter by 1 only when
        // shouldCredit is true, mirroring totalLiabilities' own
        // increment-by-select pattern. Gating on shouldCredit rather than
        // fullyPaid alone is deliberate: gating on fullyPaid alone would
        // let an already-covered address re-pad the count with repeated
        // tiny successful payments. This does NOT solve the broader "many
        // distinct real addresses each paying a tiny amount" sybil
        // problem -- see §0's open items.
        euint32 participantIncrement = FHE.select(shouldCredit, FHE.asEuint32(1), FHE.asEuint32(0));
        epochParticipantCount = FHE.add(epochParticipantCount, participantIncrement);
        FHE.allowThis(epochParticipantCount);

        emit PolicyOpened(msg.sender, currentEpoch);
    }

    // Four-stage pull model (§0 session 15 added the third stage below):
    // settleEpoch() snapshots both the epoch's participant count and its
    // premium total but marks ONLY the count decryptable;
    // finalizeParticipantCount() decrypts the count and decides
    // withhold-vs-proceed; finalizePremiumValueCheck() decrypts a single
    // "total clears minEpochPremiumTotal" BIT (computed as a still-
    // encrypted FHE.ge comparison, never by decrypting the total itself)
    // and decides withhold-vs-settle, marking the premium total decryptable
    // ONLY in the settle case; finalizePremiumSettlement() applies the
    // revealed total.
    //
    // settleEpoch itself has nothing left to decide before requesting
    // decryption: epochParticipantCount is encrypted (euint32,
    // incremented via FHE.select -- see buyCover), so it can't be read as
    // plaintext, and withhold-vs-settle now necessarily requires a
    // decryption round-trip.
    //
    // The count MUST be decrypted and verified on-chain strictly before
    // the premium total is ever marked decryptable -- not just computed
    // "before" in program order. FHE.checkSignatures verifies whatever
    // cleartexts+proof are handed to it for whatever handles were marked
    // decryptable, regardless of what the values turn out to be. Marking
    // BOTH handles decryptable in the same settleEpoch call would mean a
    // below-threshold epoch still has a valid, submittable KMS proof for
    // its premium total sitting available off-chain -- withholding would
    // be purely cosmetic. Hence the strict staged ordering below, now
    // three deep instead of two for exactly the same reason: checking
    // minEpochPremiumTotal by decrypting the real total first and
    // withholding after the fact would suffer the identical defeat, so
    // that check is inserted as its own encrypted-bit stage strictly
    // before the total is ever marked decryptable, not folded into
    // finalizePremiumSettlement after the fact.
    function settleEpoch() external {
        // §11 hardening: blocks starting a NEW settlement cycle once the
        // claim window has opened (or the pool has settled) -- it does NOT
        // affect a cycle already in flight when triggerClaimWindow fires.
        // finalizeParticipantCount/finalizePremiumValueCheck/
        // finalizePremiumSettlement all have no status gate whatsoever, the
        // same no-gate design finalizeClaim already uses (§0 session 9) --
        // so a settlement pipeline mid-decryption when ClaimWindowOpen
        // begins still resolves normally afterward via those permissionless
        // finalize calls. This require only stops a NEW settleEpoch() call
        // from starting a pipeline once the pool's underwriting phase is
        // over -- accepting new premium accounting while also paying out
        // claims would mix two economic phases this design keeps strictly
        // separate (§5: no path back to Active).
        require(status == PoolStatus.Active, "RedoubtCoverPool: premium settlement only allowed while active");
        require(!participantCountDecryptionPending, "RedoubtCoverPool: epoch settlement already pending");
        require(!premiumValueCheckPending, "RedoubtCoverPool: epoch settlement already pending");
        require(!premiumDecryptionPending, "RedoubtCoverPool: epoch settlement already pending");
        // epochLength is day-scale (§9 example: 7 days); validator-level
        // timestamp manipulation (~seconds) is not a meaningful attack here.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= epochStartTimestamp + epochLength, "RedoubtCoverPool: epoch not yet ended");

        pendingSettlementEpoch = currentEpoch;
        participantCountAwaitingDecryption = epochParticipantCount;
        premiumsAwaitingDecryption = pendingPremiums;

        // Only the count is marked decryptable here -- see the function
        // comment above for why marking the premium total here too would
        // defeat withholding entirely.
        FHE.makePubliclyDecryptable(participantCountAwaitingDecryption);
        participantCountDecryptionPending = true;
        settlementPendingSince = block.timestamp;

        // Reset both accumulators immediately, not at finalization: a
        // buyCover arriving during the pending-decryption window must
        // accumulate into a fresh bucket, not mutate a handle a KMS proof
        // has already been requested for.
        pendingPremiums = FHE.asEuint64(0);
        epochParticipantCount = FHE.asEuint32(0);
        FHE.allowThis(pendingPremiums);
        FHE.allowThis(epochParticipantCount);

        _rollEpoch();
    }

    // Permissionless: anyone holding a valid KMS proof for
    // `participantCountAwaitingDecryption` may finalize -- also the
    // "unstick" answer to §11's callback-never-arrives edge case (every
    // finalize function in this contract follows this same pattern).
    function finalizeParticipantCount(uint256[] calldata cleartexts, bytes calldata decryptionProof) external {
        require(participantCountDecryptionPending, "RedoubtCoverPool: no participant count decryption pending");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint32.unwrap(participantCountAwaitingDecryption);
        // KMS proofs are signed over abi.encodePacked(cleartexts), not
        // abi.encode (confirmed in forge-fhevm's FhevmTest.publicDecrypt
        // source -- its own testing-patterns.md doc example uses
        // abi.encode, which does not verify).
        FHE.checkSignatures(handles, abi.encodePacked(cleartexts), decryptionProof);

        uint256 count = cleartexts[0];
        uint256 settlingEpoch = pendingSettlementEpoch;
        participantCountDecryptionPending = false;

        if (count < MIN_EPOCH_PARTICIPANTS) {
            emit PremiumEpochWithheld(settlingEpoch, count);

            // Roll BOTH the withheld epoch's premium total AND its
            // participant count forward, together -- not just the amount
            // (§6). What MIN_EPOCH_PARTICIPANTS guards is "how many
            // distinct contributors back the eventual revealed total,"
            // not "how many arrived in the most recent epoch" -- resetting
            // the count while carrying the amount forward would silently
            // undercount real contributors already baked into the pot.
            // Neither handle was ever marked publicly decryptable on this
            // branch, so nothing has been revealed to anyone.
            pendingPremiums = FHE.add(pendingPremiums, premiumsAwaitingDecryption);
            epochParticipantCount = FHE.add(epochParticipantCount, participantCountAwaitingDecryption);
            FHE.allowThis(pendingPremiums);
            FHE.allowThis(epochParticipantCount);
            settlementPendingSince = 0;
            return;
        }

        // Count clears the threshold -- but the total is still NOT marked
        // decryptable yet (§0 session 15): minEpochPremiumTotal must also
        // be confirmed first, via a still-encrypted comparison, never by
        // decrypting the total itself first and checking after the fact
        // (see the pipeline-level comment above finalizeParticipantCount
        // for why that would be too late). FHE.ge here reveals nothing --
        // its ebool result is what gets marked decryptable next, one bit,
        // same shape as checkSolvency's own solvent-bit reveal.
        pendingRevealedParticipantCount = count;
        // forge-lint: disable-next-line(unsafe-typecast)
        ebool valueOk = FHE.ge(premiumsAwaitingDecryption, FHE.asEuint64(uint64(minEpochPremiumTotal)));
        FHE.allowThis(valueOk);

        premiumValueCheckPending = true;
        pendingPremiumValueCheck = valueOk;
        FHE.makePubliclyDecryptable(pendingPremiumValueCheck);
    }

    // Permissionless, same reasoning as finalizeParticipantCount above --
    // the middle stage §0 session 15 inserted (see the pipeline-level
    // comment above finalizeParticipantCount).
    function finalizePremiumValueCheck(uint256[] calldata cleartexts, bytes calldata decryptionProof) external {
        require(premiumValueCheckPending, "RedoubtCoverPool: no premium value check pending");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pendingPremiumValueCheck);
        // abi.encodePacked, not abi.encode -- see finalizeParticipantCount.
        FHE.checkSignatures(handles, abi.encodePacked(cleartexts), decryptionProof);

        bool valueOk = cleartexts[0] != 0;
        uint256 settlingEpoch = pendingSettlementEpoch;
        uint256 count = pendingRevealedParticipantCount;
        premiumValueCheckPending = false;

        if (!valueOk) {
            // Same withhold shape as finalizeParticipantCount's count-fail
            // branch above: roll BOTH accumulators forward, reveal
            // nothing. premiumsAwaitingDecryption's handle was never
            // marked publicly decryptable on this branch -- the encrypted
            // FHE.ge check in finalizeParticipantCount is precisely what
            // makes that true, unlike a decrypt-then-discard approach
            // would have been. Reuses PremiumEpochWithheld (same event as
            // the count-fail branch) since the underlying guarantee to
            // the caller is identical either way: this epoch's total was
            // not revealed.
            emit PremiumEpochWithheld(settlingEpoch, count);

            pendingPremiums = FHE.add(pendingPremiums, premiumsAwaitingDecryption);
            epochParticipantCount = FHE.add(epochParticipantCount, participantCountAwaitingDecryption);
            FHE.allowThis(pendingPremiums);
            FHE.allowThis(epochParticipantCount);
            settlementPendingSince = 0;
            return;
        }

        // Value threshold clears too -- only now does the premium total
        // become decryptable at all.
        premiumDecryptionPending = true;
        FHE.makePubliclyDecryptable(premiumsAwaitingDecryption);
    }

    // Permissionless, same reasoning as finalizeParticipantCount above.
    function finalizePremiumSettlement(uint256[] calldata cleartexts, bytes calldata decryptionProof) external {
        require(premiumDecryptionPending, "RedoubtCoverPool: no premium decryption pending");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(premiumsAwaitingDecryption);
        // abi.encodePacked, not abi.encode -- see finalizeParticipantCount.
        FHE.checkSignatures(handles, abi.encodePacked(cleartexts), decryptionProof);

        uint256 revealedTotal = cleartexts[0];
        publicReserves += revealedTotal;

        uint256 settledEpoch = pendingSettlementEpoch;
        premiumDecryptionPending = false;
        settlementPendingSince = 0;

        emit PremiumEpochSettled(settledEpoch, revealedTotal);
    }

    // §11 hardening item 4: permissionless escape hatch for a settlement
    // pipeline stage whose KMS/relayer decryption never resolves. FHEVM's
    // pull model means ordinary relayer/KMS downtime is already
    // self-healing without this function at all -- a publicly-decryptable
    // handle never expires, so any of the three finalize* functions above
    // can still succeed whenever a fresh KMS proof becomes available, no
    // matter how much time has passed. This exists only for the narrower
    // case where one specific handle becomes permanently undecryptable (a
    // KMS-side data-loss bug, not mere downtime): without an escape hatch,
    // that would brick every future settleEpoch() forever, since this
    // contract has no admin or upgrade path. decryptionTimeout is sized far
    // beyond any plausible transient outage (see its declaration), so this
    // can only fire on a genuine, long-lived stall.
    function abandonStuckSettlement() external {
        require(
            participantCountDecryptionPending || premiumValueCheckPending || premiumDecryptionPending,
            "RedoubtCoverPool: no settlement decryption pending"
        );
        // decryptionTimeout is day-scale by design (see its declaration);
        // validator-level timestamp manipulation (~seconds) is not a
        // meaningful attack here, same reasoning as settleEpoch's own
        // epochLength check.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= settlementPendingSince + decryptionTimeout, "RedoubtCoverPool: decryption timeout not yet elapsed");

        uint256 settlingEpoch = pendingSettlementEpoch;
        uint8 stage;

        if (premiumDecryptionPending) {
            // Stage 3: by this point the total was already marked publicly
            // decryptable in finalizePremiumValueCheck's proceed branch --
            // anyone who wanted to fetch a KMS proof for it off-chain
            // already could, independent of anything this function does.
            // Abandoning only means the pool itself never formalizes that
            // total into publicReserves via THIS stuck cycle; it does not
            // retroactively un-reveal anything. epochParticipantCount is
            // NOT rolled here -- it was already implicitly spent once
            // finalizeParticipantCount decided to proceed past it, and
            // there is nothing left to roll for it.
            stage = 3;
            premiumDecryptionPending = false;
            pendingPremiums = FHE.add(pendingPremiums, premiumsAwaitingDecryption);
            FHE.allowThis(pendingPremiums);
        } else {
            // Stage 1 or 2 -- identical rollback either way: neither branch
            // ever marked the premium total decryptable, so nothing has
            // been revealed to anyone on this path.
            stage = participantCountDecryptionPending ? 1 : 2;
            participantCountDecryptionPending = false;
            premiumValueCheckPending = false;
            pendingPremiums = FHE.add(pendingPremiums, premiumsAwaitingDecryption);
            epochParticipantCount = FHE.add(epochParticipantCount, participantCountAwaitingDecryption);
            FHE.allowThis(pendingPremiums);
            FHE.allowThis(epochParticipantCount);
        }

        settlementPendingSince = 0;
        emit SettlementDecryptionAbandoned(settlingEpoch, stage);
    }

    // Same pull model as settleEpoch: mark the ebool result publicly
    // decryptable here, verify + reveal only the bit in
    // finalizeSolvencyCheck. Never reveals totalLiabilities or
    // publicReserves themselves -- only "solvent: true/false" (§4/§6).
    //
    // §0 session 15 mitigation for §6's bracketing leak: rate-limited to
    // once per epoch. Two independent gates, both required:
    // solvencyCheckPending ("is a decryption already in flight") and
    // lastSolvencyCheckEpoch ("has this epoch already had its one check,
    // regardless of whether that check has finalized yet"). Deliberately
    // "once per currentEpoch," not "once per epochLength time window" --
    // currentEpoch is the exact clock every other epoch-gated check in
    // this contract already reads (buyCover's epochBought, claim's
    // holding-period check, the settlement pipeline's
    // pendingSettlementEpoch), so reusing it means this gate advances
    // exactly when settleEpoch() actually rolls the epoch, not on some
    // second, independent block.timestamp arithmetic that could drift out
    // of step with it.
    function checkSolvency() external {
        require(!solvencyCheckPending, "RedoubtCoverPool: solvency check already pending");
        require(currentEpoch != lastSolvencyCheckEpoch, "RedoubtCoverPool: solvency check already performed this epoch");
        // publicReserves must fit euint64 to be compared against
        // totalLiabilities at all -- flagging as an explicit precondition
        // rather than silently truncating on the cast below.
        require(publicReserves <= type(uint64).max, "RedoubtCoverPool: publicReserves exceeds euint64 range");

        // No division anywhere: solvency is a single FHE.le comparison,
        // never liabilities / reserves (§4, §7).
        // forge-lint: disable-next-line(unsafe-typecast)
        ebool solvent = FHE.le(totalLiabilities, FHE.asEuint64(uint64(publicReserves)));

        // FHE.le grants no automatic ACL access to its result, and
        // ACL.allowForDecryption itself requires the caller to already be
        // allowed on the handle -- so allowThis must happen before
        // makePubliclyDecryptable, not after or in either order.
        FHE.allowThis(solvent);

        lastSolvencyCheckEpoch = currentEpoch;
        solvencyCheckPending = true;
        solvencyCheckPendingSince = block.timestamp;
        pendingSolvencyResult = solvent;
        FHE.makePubliclyDecryptable(pendingSolvencyResult);
    }

    // Permissionless, same reasoning as finalizeParticipantCount above.
    function finalizeSolvencyCheck(uint256[] calldata cleartexts, bytes calldata decryptionProof) external {
        require(solvencyCheckPending, "RedoubtCoverPool: no solvency check pending");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pendingSolvencyResult);
        // abi.encodePacked, not abi.encode -- see finalizeParticipantCount.
        FHE.checkSignatures(handles, abi.encodePacked(cleartexts), decryptionProof);

        bool solvent = cleartexts[0] != 0;
        solvencyCheckPending = false;
        solvencyCheckPendingSince = 0;

        emit SolvencyChecked(solvent);
    }

    // §11 hardening item 4: same escape-hatch reasoning as
    // abandonStuckSettlement above, for a solvency check whose decryption
    // never resolves -- ordinary downtime self-heals via
    // finalizeSolvencyCheck itself; this only matters for a permanently
    // lost handle, which would otherwise block every future checkSolvency()
    // forever (the pending guard has no other way to clear).
    function abandonStuckSolvencyCheck() external {
        require(solvencyCheckPending, "RedoubtCoverPool: no solvency check pending");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= solvencyCheckPendingSince + decryptionTimeout, "RedoubtCoverPool: decryption timeout not yet elapsed");

        solvencyCheckPending = false;
        solvencyCheckPendingSince = 0;
        // The abandoned check's bit was never finalized on-chain, so there
        // is nothing for the once-per-epoch bracketing guard (§0 session
        // 15) to protect against here -- reset it to the "never" sentinel
        // so a fresh check may be initiated immediately, even in the same
        // epoch.
        lastSolvencyCheckEpoch = type(uint256).max;

        emit SolvencyCheckAbandoned();
    }

    // No FHE anywhere in this function: depegThreshold and the oracle
    // price are both plaintext by design (§4/§9) -- the depeg trigger
    // must be verifiable by anyone without any decryption step.
    function triggerClaimWindow() external {
        // Single-round pool (§5): can only fire once, never after
        // ClaimWindowOpen or Settled.
        require(status == PoolStatus.Active, "RedoubtCoverPool: not in active phase");

        // Stale-oracle guard (§11): an oracle that hasn't updated recently
        // must not be trusted to open real, irreversible claims. Checked
        // arithmetic already reverts if lastUpdated() is in the future.
        uint256 oracleAge = block.timestamp - priceOracle.lastUpdated();
        // forge-lint: disable-next-line(block-timestamp)
        require(oracleAge <= maxOracleStaleness, "RedoubtCoverPool: oracle price stale");

        uint64 price = priceOracle.latestPrice();
        require(price < depegThreshold, "RedoubtCoverPool: price not below depeg threshold");

        status = PoolStatus.ClaimWindowOpen;
        claimWindowOpenedAt = block.timestamp;

        emit ClaimWindowTriggered(currentEpoch, price);
    }

    // §0 session 9: the missing path to Settled. Permissionless and
    // time-gated, deliberately mirroring settleEpoch's own relationship
    // to epochLength -- reaching the deadline does not transition the
    // pool automatically, an explicit call is still required. This is
    // consistent with how every other phase change in this contract
    // works (buyCover stays callable exactly up to the block a pending
    // settleEpoch actually lands, even if epochLength has technically
    // elapsed already), not a new race introduced here.
    //
    // Deliberately does NOT check claimDecryptionPending for anyone: a
    // claim() call already in flight when the deadline passes must still
    // be resolvable afterward (see finalizeClaim -- it has no status
    // gate at all, by design, for exactly this reason), or that
    // policyholder's decryption would be stranded pending forever with
    // no way to finalize it. Closing the window only stops *new* claim()
    // calls (gated on status == ClaimWindowOpen); it never cuts off ones
    // already submitted.
    function settleClaimWindow() external {
        require(status == PoolStatus.ClaimWindowOpen, "RedoubtCoverPool: claim window not open");
        // claimWindowDuration is day-scale by design (see its declaration
        // comment); validator-level timestamp manipulation (~seconds) is
        // not a meaningful attack here, same reasoning as settleEpoch's
        // epochLength check.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= claimWindowOpenedAt + claimWindowDuration, "RedoubtCoverPool: claim window not yet closed");

        status = PoolStatus.Settled;

        emit ClaimEpochSettled(currentEpoch);
    }

    // Two-transaction pull model, same as settleEpoch/checkSolvency:
    // confidentialTransfer does NOT revert on insufficient pool balance,
    // it silently transfers less -- so claim() cannot know synchronously
    // whether the payout actually succeeded, and can't synchronously
    // decide whether to mark the policy claimed. nonReentrant for the
    // same structural reason as buyCover: state below can only be
    // computed after confidentialTransfer returns, so this can't be fully
    // checks-effects-interactions (§11's documented fallback).
    function claim() external nonReentrant {
        require(status == PoolStatus.ClaimWindowOpen, "RedoubtCoverPool: claim window not open");
        // FHE.isInitialized(coverage) answers "has this address ever
        // recorded a Policy at all" without a separate plaintext flag --
        // same distinction buyCover relies on. A buyer whose only
        // attempt(s) failed still passes this check (coverage is just
        // encrypted zero) and proceeds to a harmless zero-payout claim.
        require(FHE.isInitialized(policies[msg.sender].coverage), "RedoubtCoverPool: no policy");
        require(!policies[msg.sender].claimed, "RedoubtCoverPool: already claimed");
        // §0 session 13/14: minimum holding period, checked per-POLICY
        // against THIS policy's own epochBought, never pool-wide. A depeg
        // triggered soon after one buyer's purchase must only block THAT
        // buyer's claim -- long-standing holders must still be able to
        // claim normally just because someone else bought recently.
        // triggerClaimWindow itself stays untouched: it only answers "is
        // there a real, public depeg," a question with no relationship to
        // any individual buyer's timing. epochBought is (re-)set to
        // currentEpoch on every buyCover call, including a harmless
        // redundant one after a buyer is already fully covered (see
        // buyCover) -- but currentEpoch only ever moves forward
        // (_rollEpoch), so this can only ever push a holder's own
        // eligibility LATER, never pull it earlier. Not exploitable to
        // shorten the wait; the only consequence is self-inflicted (an
        // already-covered buyer who calls buyCover again resets their own
        // clock), never something one address can do to another's policy.
        require(
            currentEpoch >= policies[msg.sender].epochBought + MIN_HOLDING_EPOCHS,
            "RedoubtCoverPool: minimum holding period not elapsed"
        );
        // Per-policy guard, not a pool-wide singleton (see the mapping's
        // declaration comment): without this, a second claim() call while
        // the first's decryption is still pending could attempt a second
        // confidentialTransfer for the same policy before either resolves.
        require(!claimDecryptionPending[msg.sender], "RedoubtCoverPool: claim decryption already pending");

        euint64 payoutAmount = policies[msg.sender].coverage;

        // confidentialTransfer(to, euint64) has NO isOperator check -- it
        // moves msg.sender's OWN balance, not someone else's, so there is
        // no third-party approval to check. It still requires
        // FHE.isAllowed(amount, msg.sender) on entry, already satisfied by
        // buyCover's persistent FHE.allowThis(coverage). But _update's
        // FHESafeMath.tryDecrease runs FHE.ge/FHE.sub on `amount` AS THE
        // TOKEN CONTRACT, so the token needs its own fresh grant --
        // coverage was never handed to the token before (only premium
        // was, in buyCover).
        FHE.allow(payoutAmount, address(premiumToken));

        // Does NOT revert on insufficient pool balance -- transferred is
        // either payoutAmount (success) or less (failure) per
        // FHESafeMath's own success/0 pattern.
        euint64 transferred = premiumToken.confidentialTransfer(msg.sender, payoutAmount);

        // Unlike buyCover's `transferred`, this needs no extra ACL grant
        // for the pool's own use: confidentialTransfer's internal _update
        // has `from == this pool contract` (claim() calls
        // confidentialTransfer(claimant, amount)), and _update's own tail
        // unconditionally does FHE.allow(transferred, from) -- the pool
        // already has persistent access without any extra call here.
        ebool fullyPaid = FHE.eq(transferred, payoutAmount);

        // Kept explicit despite FHE.eq's transient auto-grant to this
        // contract: an explicit persistent grant is clearer than relying
        // on same-transaction auto-grant timing, and matches the pattern
        // used everywhere else in this contract.
        FHE.allowThis(fullyPaid);
        FHE.makePubliclyDecryptable(fullyPaid);

        claimDecryptionPending[msg.sender] = true;
        claimPendingSince[msg.sender] = block.timestamp;
        pendingClaimResult[msg.sender] = fullyPaid;
    }

    // Permissionless like every other finalize function -- deliberately
    // NOT restricted to the claimant. A user-decrypt-only design (only
    // the claimant could authorize decryption of their own fullyPaid bit)
    // was rejected: an unresponsive or key-losing claimant's pending
    // claim could never be unstuck by anyone else, a worse liveness
    // property than the marginal leak of a public success/fail bit for a
    // claim whose existence is already public (§6).
    //
    // On failure: policy.claimed stays false and totalLiabilities is
    // untouched, so the caller may call claim() again later -- not
    // permanently stuck either paid or blocked.
    function finalizeClaim(address holder, uint256[] calldata cleartexts, bytes calldata decryptionProof) external {
        require(claimDecryptionPending[holder], "RedoubtCoverPool: no claim decryption pending");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pendingClaimResult[holder]);
        // abi.encodePacked, not abi.encode -- see finalizeParticipantCount.
        FHE.checkSignatures(handles, abi.encodePacked(cleartexts), decryptionProof);

        bool fullyPaid = cleartexts[0] != 0;
        claimDecryptionPending[holder] = false;
        claimPendingSince[holder] = 0;

        if (fullyPaid) {
            policies[holder].claimed = true;

            // Tied to the success path only: decrementing this for an
            // attempt that didn't actually pay out would understate
            // totalLiabilities and undermine the solvency guarantee
            // checkSolvency exists to prove.
            totalLiabilities = FHE.sub(totalLiabilities, policies[holder].coverage);
            FHE.allowThis(totalLiabilities);

            emit ClaimPaid(holder, currentEpoch);
        }
    }

    // §11 hardening item 4: NOT the same shape as
    // abandonStuckSettlement/abandonStuckSolvencyCheck above -- those two
    // guard pure encrypted bookkeeping with no external transfer involved,
    // so rolling back and allowing a fresh attempt is unconditionally safe.
    // claim() is different: its confidentialTransfer already executed
    // SYNCHRONOUSLY and unconditionally the moment claim() was called --
    // fullyPaid's true value is already fixed on-chain, this contract just
    // can't decrypt it yet. Abandoning must NOT reopen claim() for this
    // holder: since we can never learn whether the stuck attempt actually
    // transferred the full payout or nothing, allowing a retry risks a
    // SECOND real confidentialTransfer of the same payoutAmount stacked on
    // top of an already-successful first one -- a direct double-payment,
    // not just a bookkeeping inconsistency. Marking claimed=true forecloses
    // that unconditionally, at the cost of a possible false negative: a
    // holder whose stuck attempt actually failed (transferred 0) is now
    // wrongly locked out of ever retrying a legitimate claim. Deliberate
    // conservative bias -- a wrongly-denied claim is a support-channel
    // problem; a double payment is a direct fund drain undermining the
    // exact solvency guarantee checkSolvency exists to prove. totalLiabilities
    // is deliberately left untouched either way: the true outcome is
    // unknowable here, so not adjusting it is the conservative default
    // (worst case, checkSolvency reports MORE pessimistically than the real
    // truth, never less).
    function abandonStuckClaim(address holder) external {
        require(claimDecryptionPending[holder], "RedoubtCoverPool: no claim decryption pending");
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp >= claimPendingSince[holder] + decryptionTimeout, "RedoubtCoverPool: decryption timeout not yet elapsed");

        claimDecryptionPending[holder] = false;
        claimPendingSince[holder] = 0;
        policies[holder].claimed = true;

        emit ClaimDecryptionAbandoned(holder);
    }

    function _rollEpoch() internal {
        currentEpoch++;
        epochStartTimestamp = block.timestamp;
    }
}
