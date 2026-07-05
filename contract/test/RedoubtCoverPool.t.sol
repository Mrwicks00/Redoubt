// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {externalEuint64, euint64, euint32, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ERC7984Mock} from "@openzeppelin/confidential-contracts/mocks/token/ERC7984Mock.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {FHEVMExecutor} from "@fhevm/host-contracts/contracts/FHEVMExecutor.sol";
import {RedoubtCoverPool} from "../src/RedoubtCoverPool.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {ReentrantERC7984Mock} from "./mocks/ReentrantERC7984Mock.sol";

contract RedoubtCoverPoolTest is FhevmTest {
    uint256 internal constant BUYER_PK = 0xA11CE;
    uint256 internal constant BUYER2_PK = 0xB0B;
    uint256 internal constant BUYER3_PK = 0xC0FFEE;
    uint256 internal constant PREMIUM_RATE_BPS = 500; // 5%
    uint256 internal constant EPOCH_LENGTH = 7 days;
    uint256 internal constant CLAIM_WINDOW_DURATION = 14 days;
    // §11 hardening item 3: unchanged in behavior from the constant this
    // replaced -- see RedoubtCoverPool.sol's maxOracleStaleness declaration
    // for the reasoning.
    uint256 internal constant MAX_ORACLE_STALENESS = 1 hours;
    // §11 hardening item 4: unchanged in behavior from before this became a
    // constructor param -- see RedoubtCoverPool.sol's decryptionTimeout
    // declaration for the reasoning. 1 days is easy to vm.warp past in
    // tests while still being far beyond any real measured KMS/relayer
    // latency.
    uint256 internal constant DECRYPTION_TIMEOUT = 1 days;
    // §0 session 15: chosen so this suite's existing "sufficient
    // participants" fixture (3 buyers, 30_000 combined premium) clears it
    // comfortably, while a dust-padded epoch (3 buyers each paying a
    // premium of 1) does not -- see test_finalizePremiumValueCheck_* below.
    uint256 internal constant MIN_EPOCH_PREMIUM_TOTAL = 10_000;
    uint64 internal constant PEGGED_PRICE = 1.00e8;
    uint64 internal constant DEPEG_THRESHOLD = 0.95e8;
    uint64 internal constant DEPEGGED_PRICE = 0.80e8;

    address internal buyer;
    ERC7984Mock internal token;
    MockPriceOracle internal oracle;
    RedoubtCoverPool internal pool;

    function setUp() public override {
        super.setUp();
        buyer = vm.addr(BUYER_PK);

        token = new ERC7984Mock("Mock cUSD", "cUSD", "");
        oracle = new MockPriceOracle(PEGGED_PRICE);
        pool = new RedoubtCoverPool(
            token,
            PREMIUM_RATE_BPS,
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            MAX_ORACLE_STALENESS,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );

        token.$_mint(buyer, uint64(1_000_000));
    }

    function _buyCoverAs(uint256 pk, uint64 coverageAmount) internal returns (address) {
        return _buyCoverOnAs(pool, pk, coverageAmount);
    }

    function _buyCoverOnAs(RedoubtCoverPool targetPool, uint256 pk, uint64 coverageAmount) internal returns (address) {
        address account = vm.addr(pk);
        token.$_mint(account, coverageAmount);

        vm.prank(account);
        token.setOperator(address(targetPool), uint48(block.timestamp + 1 days));

        (externalEuint64 handle, bytes memory proof) = encryptUint64(coverageAmount, account, address(targetPool));

        vm.prank(account);
        targetPool.buyCover(handle, proof);

        return account;
    }

    // Decrypts and finalizes the participant-count stage only (§0 session
    // 8's three-stage pipeline), returning the revealed count. Does not
    // assume the count clears MIN_EPOCH_PARTICIPANTS -- callers that need
    // the premium total too must check premiumDecryptionPending() first.
    function _finalizeParticipantCount(RedoubtCoverPool targetPool) internal returns (uint256 count) {
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint32.unwrap(targetPool.participantCountAwaitingDecryption());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);

        targetPool.finalizeParticipantCount(cleartexts, decryptionProof);
        return cleartexts[0];
    }

    // Decrypts and finalizes the premium-value-check stage only (§0 session
    // 15's insertion into the pipeline), returning whether the total
    // cleared minEpochPremiumTotal. Does not assume it did -- callers that
    // need the total revealed too must check premiumDecryptionPending()
    // first.
    function _finalizePremiumValueCheck(RedoubtCoverPool targetPool) internal returns (bool valueOk) {
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(targetPool.pendingPremiumValueCheck());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);

        targetPool.finalizePremiumValueCheck(cleartexts, decryptionProof);
        return cleartexts[0] != 0;
    }

    // Runs a full settleEpoch -> finalizeParticipantCount ->
    // finalizePremiumValueCheck -> finalizePremiumSettlement cycle and
    // returns the revealed total, for tests that need publicReserves
    // actually funded rather than just testing settlement itself. Only
    // valid when the epoch is expected to clear BOTH
    // MIN_EPOCH_PARTICIPANTS and minEpochPremiumTotal -- callers testing
    // either withheld path should drive the stages manually instead.
    function _settleAndFinalize(RedoubtCoverPool targetPool) internal returns (uint256 revealedTotal) {
        targetPool.settleEpoch();
        _finalizeParticipantCount(targetPool);
        _finalizePremiumValueCheck(targetPool);

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(targetPool.premiumsAwaitingDecryption());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);

        targetPool.finalizePremiumSettlement(cleartexts, decryptionProof);
        return cleartexts[0];
    }

    // Rolls the pool forward exactly one epoch via settleEpoch() -- the
    // only way currentEpoch ever advances (_rollEpoch is internal). Used
    // to clear MIN_HOLDING_EPOCHS in tests that need a claim against a
    // policy bought in a prior epoch. Leaves that epoch's participant-count
    // decryption unresolved (finalizeParticipantCount is never called) --
    // harmless for callers that only care about currentEpoch having moved,
    // not about completing that epoch's settlement pipeline.
    function _advanceEpoch(RedoubtCoverPool targetPool) internal {
        vm.warp(block.timestamp + EPOCH_LENGTH);
        targetPool.settleEpoch();
    }

    // Runs a full claim -> publicDecrypt -> finalizeClaim cycle as
    // `claimant` and returns whether the payout fully succeeded.
    function _claimAndFinalize(RedoubtCoverPool targetPool, address claimant) internal returns (bool fullyPaid) {
        vm.prank(claimant);
        targetPool.claim();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(targetPool.pendingClaimResult(claimant));
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);

        targetPool.finalizeClaim(claimant, cleartexts, decryptionProof);
        return cleartexts[0] != 0;
    }


    function test_buyCover_storesCoverageAndGrantsHolderAcl() public {
        uint64 coverageAmount = 100_000;

        // Prerequisite ERC-7984 operator grant -- separate from the FHE ACL
        // grant the contract makes internally. Without this, buyCover's
        // call into confidentialTransferFrom reverts with
        // ERC7984UnauthorizedSpender (loud, not a silent ACL-style failure).
        vm.prank(buyer);
        token.setOperator(address(pool), uint48(block.timestamp + 1 days));

        (externalEuint64 handle, bytes memory proof) = encryptUint64(coverageAmount, buyer, address(pool));

        vm.prank(buyer);
        pool.buyCover(handle, proof);

        (euint64 storedCoverage, uint256 epochBought, bool claimed) = pool.policies(buyer);
        assertEq(epochBought, 0);
        assertFalse(claimed);

        // Exercises the ACL grant specifically: userDecrypt enforces both
        // persistent contract allowance (FHE.allowThis) and persistent
        // holder allowance (FHE.allow), matching the production EIP-712
        // user-decrypt flow rather than the ACL-bypassing decrypt().
        bytes memory signature = signUserDecrypt(BUYER_PK, address(pool));
        uint256 cleartext = userDecrypt(euint64.unwrap(storedCoverage), buyer, address(pool), signature);
        assertEq(cleartext, coverageAmount);
    }

    function test_buyCover_revertsWithoutOperatorApproval() public {
        // No token.setOperator call for `pool` here -- confirms the
        // operator-approval gate is enforced and fails loudly, not
        // silently, unlike a missing FHE ACL grant.
        (externalEuint64 handle, bytes memory proof) = encryptUint64(100_000, buyer, address(pool));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ERC7984.ERC7984UnauthorizedSpender.selector, buyer, address(pool)));
        pool.buyCover(handle, proof);
    }

    // The most important test in the whole suite (§0 session 6) -- more
    // important than any happy-path test, since it protects the core
    // solvency guarantee checkSolvency exists to prove. An account with
    // pool operator approval but an insufficient token balance must not be
    // able to record real coverage: confidentialTransferFrom does not
    // revert on insufficient balance (it silently transfers less), so
    // without the FHE.select-gated crediting this session added, buyCover
    // would record the full requested coverage regardless of whether any
    // premium was actually paid.
    //
    // Deliberately gives the buyer a SMALL but nonzero, INITIALIZED
    // balance rather than none at all. A truly untouched balance hits a
    // different, loud-reverting guard (ERC7984ZeroBalance,
    // require(FHE.isInitialized(fromBalance))) -- confirmed by first
    // writing this test with zero balance and getting that revert instead
    // of the silent-failure path this test is actually meant to exercise.
    // The real exploit needs an initialized-but-insufficient balance (e.g.
    // an attacker who received any dust at all, or self-funded a trivial
    // amount), which is what this reproduces.
    function test_buyCover_recordsNoLiabilityWhenPaymentFails() public {
        address emptyBuyer = vm.addr(BUYER2_PK);
        uint64 requestedCoverage = 100_000; // premium would be 5_000
        token.$_mint(emptyBuyer, uint64(1)); // initialized, far short of the 5_000 premium owed

        vm.prank(emptyBuyer);
        token.setOperator(address(pool), uint48(block.timestamp + 1 days));

        (externalEuint64 handle, bytes memory proof) =
            encryptUint64(requestedCoverage, emptyBuyer, address(pool));

        // Does NOT revert -- confidentialTransferFrom's silent-failure
        // behavior means the call succeeds, it just must not credit
        // anything real.
        vm.prank(emptyBuyer);
        pool.buyCover(handle, proof);

        // §0 session 8: unlike sessions 6-7, a failed payment here no
        // longer permanently consumes the caller's policy slot -- see
        // test_buyCover_allowsRetryAfterFailedPayment below for the
        // retry path this test's setup used to be unable to prove.

        (euint64 storedCoverage,, bool claimed) = pool.policies(emptyBuyer);
        assertFalse(claimed);

        // The critical assertion: stored coverage is 0, not the requested
        // 100_000, despite buyCover succeeding.
        bytes memory signature = signUserDecrypt(BUYER2_PK, address(pool));
        uint256 decryptedCoverage =
            userDecrypt(euint64.unwrap(storedCoverage), emptyBuyer, address(pool), signature);
        assertEq(decryptedCoverage, 0);

        // Aggregate-level confirmation, not just the individual policy:
        // with the only buyCover call in this test having paid nothing,
        // totalLiabilities must still be 0. checkSolvency against 0
        // publicReserves reporting solvent (0 <= 0) is decisive proof --
        // if the phantom-liability bug were present, totalLiabilities
        // would be 100_000 and this would report insolvent instead.
        pool.checkSolvency();
        bytes32[] memory solvencyHandle = new bytes32[](1);
        solvencyHandle[0] = ebool.unwrap(pool.pendingSolvencyResult());
        (uint256[] memory solvencyCleartexts, bytes memory solvencyProof) = publicDecrypt(solvencyHandle);
        assertEq(solvencyCleartexts[0], 1);
        pool.finalizeSolvencyCheck(solvencyCleartexts, solvencyProof);
    }

    // §0 session 8 -- the retry-blocking fix this session was really
    // about. A first buyCover attempt with an underfunded balance must
    // not permanently lock the buyer out: after topping up, a second
    // attempt from the SAME address must succeed and be credited
    // correctly. Against the code shipped through session 7 (a
    // synchronous `require(!hasPolicy[msg.sender])`), the second call
    // below would revert with "RedoubtCoverPool: policy already open" --
    // confirmed by temporarily reinstating that require and rerunning
    // this test, which failed exactly that way, before removing it again.
    function test_buyCover_allowsRetryAfterFailedPayment() public {
        address retryBuyer = vm.addr(BUYER2_PK);
        uint64 requestedCoverage = 100_000; // premium would be 5_000
        token.$_mint(retryBuyer, uint64(1)); // initialized, far short of the 5_000 premium owed

        vm.prank(retryBuyer);
        token.setOperator(address(pool), uint48(block.timestamp + 1 days));

        (externalEuint64 firstHandle, bytes memory firstProof) =
            encryptUint64(requestedCoverage, retryBuyer, address(pool));

        vm.prank(retryBuyer);
        pool.buyCover(firstHandle, firstProof);

        bytes memory signature = signUserDecrypt(BUYER2_PK, address(pool));
        (euint64 coverageAfterFailure,,) = pool.policies(retryBuyer);
        assertEq(userDecrypt(euint64.unwrap(coverageAfterFailure), retryBuyer, address(pool), signature), 0);

        // Top up well past the premium owed, then retry from the same
        // address.
        token.$_mint(retryBuyer, uint64(10_000));

        (externalEuint64 secondHandle, bytes memory secondProof) =
            encryptUint64(requestedCoverage, retryBuyer, address(pool));

        vm.prank(retryBuyer);
        pool.buyCover(secondHandle, secondProof);

        (euint64 coverageAfterRetry,, bool claimed) = pool.policies(retryBuyer);
        assertFalse(claimed);
        uint256 decryptedCoverage =
            userDecrypt(euint64.unwrap(coverageAfterRetry), retryBuyer, address(pool), signature);
        assertEq(decryptedCoverage, requestedCoverage);

        // Aggregate-level confirmation, mirroring
        // test_buyCover_recordsNoLiabilityWhenPaymentFails: totalLiabilities
        // must reflect exactly the one successful credit (100_000), not
        // double-counted and not still 0.
        pool.checkSolvency();
        bytes32[] memory solvencyHandle = new bytes32[](1);
        solvencyHandle[0] = ebool.unwrap(pool.pendingSolvencyResult());
        (uint256[] memory solvencyCleartexts, bytes memory solvencyProof) = publicDecrypt(solvencyHandle);
        // publicReserves is still 0 (no settlement happened), so solvency
        // against a real 100_000 liability must report insolvent -- the
        // decisive proof the retry was actually credited, not silently
        // dropped a second time.
        assertEq(solvencyCleartexts[0], 0);
        pool.finalizeSolvencyCheck(solvencyCleartexts, solvencyProof);
    }

    // §0 session 8 -- a buyer who ALREADY has a real, fully-paid policy
    // must not be able to double-credit totalLiabilities by calling
    // buyCover again. This is the flip side of the retry fix: removing
    // the synchronous hasPolicy gate must not reopen the phantom-liability
    // bug sessions 5-6 closed.
    function test_buyCover_secondSuccessfulCallDoesNotDoubleCreditAnAlreadyCoveredBuyer() public {
        address repeatBuyer = vm.addr(BUYER2_PK);
        uint64 firstCoverage = 100_000; // premium 5_000
        uint64 secondCoverage = 40_000; // premium 2_000
        token.$_mint(repeatBuyer, uint64(firstCoverage) + uint64(secondCoverage));

        vm.prank(repeatBuyer);
        token.setOperator(address(pool), uint48(block.timestamp + 1 days));

        (externalEuint64 firstHandle, bytes memory firstProof) =
            encryptUint64(firstCoverage, repeatBuyer, address(pool));
        vm.prank(repeatBuyer);
        pool.buyCover(firstHandle, firstProof);

        (externalEuint64 secondHandle, bytes memory secondProof) =
            encryptUint64(secondCoverage, repeatBuyer, address(pool));
        vm.prank(repeatBuyer);
        pool.buyCover(secondHandle, secondProof);

        // Stored coverage must still be the FIRST amount, not the second,
        // and not the sum of both -- the decisive proof that a second
        // real payment from an already-covered buyer doesn't double-credit
        // or overwrite the locked-in coverage.
        bytes memory signature = signUserDecrypt(BUYER2_PK, address(pool));
        (euint64 storedCoverage,,) = pool.policies(repeatBuyer);
        assertEq(userDecrypt(euint64.unwrap(storedCoverage), repeatBuyer, address(pool), signature), firstCoverage);
    }

    // §10 test #1 -- the single most important test in the suite: the
    // leakage-model guarantee (§6) that thin epochs never reveal an
    // individual-level-reversible aggregate, made executable.
    //
    // Three-stage pipeline now (§0 session 8, superseding session 3's
    // two-stage design): settleEpoch() itself can no longer decide
    // withhold-vs-settle (the participant count is encrypted now, gating
    // the sybil-padding fix), so it always proceeds to the
    // participant-count decryption stage. The withhold decision -- and
    // the PremiumEpochWithheld event -- now happens in
    // finalizeParticipantCount.
    function test_settleEpoch_withholdsThinEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);
        // Only 2 participants, below MIN_EPOCH_PARTICIPANTS (3).

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();

        assertEq(pool.currentEpoch(), 1);
        assertTrue(pool.participantCountDecryptionPending());
        assertFalse(pool.premiumDecryptionPending());

        // The leakage guarantee made concrete at the handle level, before
        // the count is even known to be below threshold: the premium
        // total's handle must not be publicly decryptable at all right
        // after settleEpoch() -- not "not yet finalized", genuinely not
        // decryptable. Queried directly against the ACL contract
        // (isAllowedForDecryption, a plain view call) rather than by
        // attempting a real publicDecrypt() and expecting it to revert:
        // publicDecrypt() internally drains forge-fhevm's recorded-log
        // buffer via vm.getRecordedLogs() as a side effect that survives
        // a revert (cheatcode state isn't rolled back with EVM state), so
        // a deliberately-reverting publicDecrypt() call earlier in a test
        // silently starves every subsequent real publicDecrypt() call in
        // the same test of the logs it needs -- confirmed by first
        // writing this check that way and watching the LATER, unrelated
        // countCleartexts assertion fail with an unexplained 0 instead of
        // 2, purely from this ordering issue, before switching to the
        // direct ACL query below.
        bytes32 premiumHandle = euint64.unwrap(pool.premiumsAwaitingDecryption());
        assertFalse(_acl.isAllowedForDecryption(premiumHandle));

        bytes32[] memory countHandles = new bytes32[](1);
        countHandles[0] = euint32.unwrap(pool.participantCountAwaitingDecryption());
        (uint256[] memory countCleartexts, bytes memory countProof) = publicDecrypt(countHandles);
        assertEq(countCleartexts[0], 2);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.PremiumEpochWithheld(0, 2);
        pool.finalizeParticipantCount(countCleartexts, countProof);

        assertFalse(pool.participantCountDecryptionPending());
        assertFalse(pool.premiumDecryptionPending());

        // Still not decryptable even after the count resolves to
        // "withheld" -- confirms finalizeParticipantCount's withhold
        // branch never calls FHE.makePubliclyDecryptable on the premium
        // handle either.
        assertFalse(_acl.isAllowedForDecryption(premiumHandle));

        uint256[] memory dummyCleartexts = new uint256[](1);
        vm.expectRevert("RedoubtCoverPool: no premium decryption pending");
        pool.finalizePremiumSettlement(dummyCleartexts, bytes(""));

        assertEq(pool.publicReserves(), 0);
    }

    // §0 session 8: closes session 6's sybil-padding gap. A failed
    // (underfunded) buyCover attempt must not count toward
    // MIN_EPOCH_PARTICIPANTS -- against the code shipped through session
    // 7 (a plaintext epochParticipantCount[epoch]++ incremented
    // unconditionally in buyCover), this epoch would have shown 3
    // participants and SETTLED instead of withholding, despite only 2
    // real payers -- confirmed by temporarily reverting the participant
    // counter to an unconditional plaintext increment and rerunning this
    // test, which failed (asserted count of 2, got 3), before restoring
    // the fix.
    function test_settleEpoch_failedPaymentDoesNotCountTowardParticipants() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);

        address emptyBuyer = vm.addr(BUYER3_PK);
        token.$_mint(emptyBuyer, uint64(1)); // initialized, far short of any real premium
        vm.prank(emptyBuyer);
        token.setOperator(address(pool), uint48(block.timestamp + 1 days));
        (externalEuint64 handle, bytes memory proof) = encryptUint64(300_000, emptyBuyer, address(pool));
        vm.prank(emptyBuyer);
        pool.buyCover(handle, proof);
        // 3 buyCover calls total, but only 2 actually paid.

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();

        uint256 count = _finalizeParticipantCount(pool);
        assertEq(count, 2);
        // Still withheld, not settled, despite 3 buyCover calls.
        assertFalse(pool.premiumDecryptionPending());
    }

    // §10 test #2 -- settlement with sufficient participants. Three-step
    // per the real pipeline (§0 session 8): settleEpoch() marks the
    // participant count decryptable and rolls the epoch immediately;
    // finalizeParticipantCount() confirms the count clears the threshold
    // and, only then, marks the premium total decryptable;
    // finalizePremiumSettlement() applies the KMS-verified total.
    function test_settleEpoch_settlesWithSufficientParticipants() public {
        _buyCoverAs(BUYER_PK, 100_000); // premium 5_000
        _buyCoverAs(BUYER2_PK, 200_000); // premium 10_000
        _buyCoverAs(BUYER3_PK, 300_000); // premium 15_000
        uint256 expectedTotal = 30_000;

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();

        assertEq(pool.currentEpoch(), 1);
        assertTrue(pool.participantCountDecryptionPending());
        assertEq(pool.pendingSettlementEpoch(), 0);

        uint256 count = _finalizeParticipantCount(pool);
        assertEq(count, 3);
        assertFalse(pool.participantCountDecryptionPending());
        // §0 session 15: count clearing MIN_EPOCH_PARTICIPANTS moves the
        // pipeline into the NEW premium-value-check stage, not straight to
        // premiumDecryptionPending -- the total isn't marked decryptable
        // until minEpochPremiumTotal is confirmed too.
        assertTrue(pool.premiumValueCheckPending());
        assertFalse(pool.premiumDecryptionPending());

        bool valueOk = _finalizePremiumValueCheck(pool);
        assertTrue(valueOk); // 30_000 >= MIN_EPOCH_PREMIUM_TOTAL (10_000)
        assertFalse(pool.premiumValueCheckPending());
        assertTrue(pool.premiumDecryptionPending());

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(pool.premiumsAwaitingDecryption());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        assertEq(cleartexts[0], expectedTotal);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.PremiumEpochSettled(0, expectedTotal);
        pool.finalizePremiumSettlement(cleartexts, decryptionProof);

        assertEq(pool.publicReserves(), expectedTotal);
        assertFalse(pool.premiumDecryptionPending());
    }

    // §0 session 15's thin-VALUE mitigation for the sybil-identity gap
    // (§0's other genuinely-open item): headcount alone was never enough
    // -- MIN_EPOCH_PARTICIPANTS only bounds how many distinct addresses
    // paid, not how much real value they paid. Three distinct real
    // addresses each paying a dust premium clear MIN_EPOCH_PARTICIPANTS
    // exactly like three genuine buyers do, but the combined total here
    // (3) is far below MIN_EPOCH_PREMIUM_TOTAL (10_000) -- must withhold,
    // not just the participant-count check from session 8.
    function test_finalizePremiumValueCheck_withholdsWhenTotalBelowThreshold() public {
        // coverage 20 @ 5% = premium 1 (integer division), so 3
        // participants together pay a combined premium of 3.
        _buyCoverAs(BUYER_PK, 20);
        _buyCoverAs(BUYER2_PK, 20);
        _buyCoverAs(BUYER3_PK, 20);

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();

        uint256 count = _finalizeParticipantCount(pool);
        assertEq(count, 3); // clears MIN_EPOCH_PARTICIPANTS on headcount alone
        assertTrue(pool.premiumValueCheckPending());
        assertFalse(pool.premiumDecryptionPending());

        // Leakage guarantee at the handle level, same style as
        // test_settleEpoch_withholdsThinEpoch: the premium total's handle
        // must never become publicly decryptable at all on this branch --
        // not "not yet finalized," genuinely never marked decryptable,
        // which is exactly what makes the FHE.ge check (rather than a
        // decrypt-then-discard approach) load-bearing here.
        bytes32 premiumHandle = euint64.unwrap(pool.premiumsAwaitingDecryption());
        assertFalse(_acl.isAllowedForDecryption(premiumHandle));

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.PremiumEpochWithheld(0, 3);
        bool valueOk = _finalizePremiumValueCheck(pool);
        assertFalse(valueOk);

        assertFalse(pool.premiumValueCheckPending());
        assertFalse(pool.premiumDecryptionPending());
        assertFalse(_acl.isAllowedForDecryption(premiumHandle));
        assertEq(pool.publicReserves(), 0);
    }

    // §6's "the pending amount rolls into the next epoch instead of
    // settling," made concrete for the new pipeline: a withheld epoch's
    // premiums must not be lost -- they accumulate into the live
    // accumulator so a later epoch that DOES clear the threshold settles
    // the combined total.
    function test_settleEpoch_rollsWithheldPremiumsIntoNextEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000); // premium 5_000
        _buyCoverAs(BUYER2_PK, 200_000); // premium 10_000
        // Only 2 participants this epoch -- withheld.

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();
        uint256 firstCount = _finalizeParticipantCount(pool);
        assertEq(firstCount, 2);
        assertFalse(pool.premiumDecryptionPending());

        // Epoch 1: one more real buyer brings the COMBINED total to 3
        // participants across both epochs (the withheld epoch's 2 rolled
        // forward, plus this one) -- settles this time.
        _buyCoverAs(BUYER3_PK, 300_000); // premium 15_000

        vm.warp(block.timestamp + EPOCH_LENGTH);
        uint256 revealedTotal = _settleAndFinalize(pool);

        // 5_000 + 10_000 (rolled forward from the withheld epoch) +
        // 15_000 (this epoch) -- proves the withheld epoch's premiums
        // were never lost.
        assertEq(revealedTotal, 30_000);
        assertEq(pool.publicReserves(), 30_000);
    }

    // §11's "decryption callback race" edge case, made concrete: a second
    // settleEpoch() call must not be able to overwrite the in-flight
    // snapshot handles while EITHER stage of the previous pipeline
    // (participant-count decryption or premium decryption) is still
    // unresolved.
    function test_settleEpoch_revertsWhileSettlementPending() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);
        _buyCoverAs(BUYER3_PK, 300_000);

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();
        assertTrue(pool.participantCountDecryptionPending());

        vm.expectRevert("RedoubtCoverPool: epoch settlement already pending");
        pool.settleEpoch();

        uint256 count = _finalizeParticipantCount(pool);
        assertEq(count, 3);
        // §0 session 15: the count stage resolved, but the NEW
        // premium-value-check stage hasn't -- still guarded.
        assertTrue(pool.premiumValueCheckPending());

        vm.expectRevert("RedoubtCoverPool: epoch settlement already pending");
        pool.settleEpoch();

        _finalizePremiumValueCheck(pool);
        assertTrue(pool.premiumDecryptionPending());

        // Still guarded: the value-check stage resolved too, but the
        // premium-total stage hasn't -- a second settleEpoch() here would
        // overwrite premiumsAwaitingDecryption out from under the
        // still-outstanding proof request for the current one.
        vm.expectRevert("RedoubtCoverPool: epoch settlement already pending");
        pool.settleEpoch();
    }

    // §11 hardening item 1: a NEW settleEpoch() cycle must not be startable
    // once the claim window has opened -- the depeg is already public
    // knowledge at that point, and accepting new premium accounting while
    // also paying out claims mixes two phases this design keeps separate.
    // No epoch warp needed: the status check is the first require in
    // settleEpoch(), so it fails before the timing check is ever reached.
    function test_settleEpoch_revertsWhileClaimWindowOpen() public {
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();
        assertEq(uint256(pool.status()), uint256(RedoubtCoverPool.PoolStatus.ClaimWindowOpen));

        vm.expectRevert("RedoubtCoverPool: premium settlement only allowed while active");
        pool.settleEpoch();
    }

    // §10 test #3 -- solvency correctness: insolvent case. Before any
    // premium settlement, publicReserves is still 0 while totalLiabilities
    // > 0, so the pool must report insolvent (le(liabilities, 0) is false
    // for any liabilities > 0).
    function test_checkSolvency_insolventCase() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);
        assertEq(pool.publicReserves(), 0);

        pool.checkSolvency();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pool.pendingSolvencyResult());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        assertEq(cleartexts[0], 0);

        vm.expectEmit(false, false, false, true, address(pool));
        emit RedoubtCoverPool.SolvencyChecked(false);
        pool.finalizeSolvencyCheck(cleartexts, decryptionProof);

        assertFalse(pool.solvencyCheckPending());
    }

    // §10 test #3 -- solvency correctness: solvent case. Uses a dedicated
    // 100%-rate pool (PREMIUM_RATE_DENOMINATOR itself, not a fraction of
    // it) so that after one full settlement cycle publicReserves exactly
    // equals totalLiabilities -- a deterministic way to "seed known
    // encrypted liabilities and public reserves" per §10, without adding
    // any reserve-funding mechanism beyond what the contract already has.
    // FHE.le is <=, so exact equality still counts as solvent.
    function test_checkSolvency_solventCase() public {
        RedoubtCoverPool fullyFundedPool = new RedoubtCoverPool(
            token,
            pool.PREMIUM_RATE_DENOMINATOR(),
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            MAX_ORACLE_STALENESS,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );

        _buyCoverOnAs(fullyFundedPool, BUYER_PK, 100_000);
        _buyCoverOnAs(fullyFundedPool, BUYER2_PK, 200_000);
        _buyCoverOnAs(fullyFundedPool, BUYER3_PK, 300_000);

        vm.warp(block.timestamp + EPOCH_LENGTH);
        uint256 revealedPremiums = _settleAndFinalize(fullyFundedPool);
        assertEq(revealedPremiums, 600_000);
        assertEq(fullyFundedPool.publicReserves(), 600_000);

        fullyFundedPool.checkSolvency();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(fullyFundedPool.pendingSolvencyResult());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        assertEq(cleartexts[0], 1);

        vm.expectEmit(false, false, false, true, address(fullyFundedPool));
        emit RedoubtCoverPool.SolvencyChecked(true);
        fullyFundedPool.finalizeSolvencyCheck(cleartexts, decryptionProof);

        assertFalse(fullyFundedPool.solvencyCheckPending());
    }

    // §10 test #4 -- solvency uses FHE.le exclusively, never division.
    // Deliberately avoids vm.ffi (source-text grep would need ffi = true
    // in foundry.toml, a project-wide toggle not worth flipping for one
    // check). Instead asserts, behaviorally, that checkSolvency() never
    // calls fheDiv/fheRem on the real FHEVMExecutor -- stronger than a
    // text grep, since it would also catch division reached through
    // indirection, not just a literal `FHE.div(` string. Confirmed
    // separately by direct source grep (see §0 session 4 log) that the
    // only FHE.div call in the whole contract is buyCover's
    // plaintext-constant premium calculation.
    function test_checkSolvency_neverUsesDivision() public {
        _buyCoverAs(BUYER_PK, 100_000);

        vm.expectCall(address(_executor), abi.encodeWithSelector(FHEVMExecutor.fheDiv.selector), 0);
        vm.expectCall(address(_executor), abi.encodeWithSelector(FHEVMExecutor.fheRem.selector), 0);

        pool.checkSolvency();
    }

    // §0 session 15's rate-limit mitigation for §6's bracketing leak: a
    // second checkSolvency() call within the SAME epoch must revert, even
    // after the first call's decryption has already fully finalized -- the
    // gate is "how many epochs has this been called in," not "is a
    // decryption currently in flight" (solvencyCheckPending already covers
    // that, separately -- see test_checkSolvency_revertsWhilePending below
    // for proof the two gates are independent).
    function test_checkSolvency_revertsOnSecondCallInSameEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);

        pool.checkSolvency();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pool.pendingSolvencyResult());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        pool.finalizeSolvencyCheck(cleartexts, decryptionProof);
        assertFalse(pool.solvencyCheckPending());

        // Same epoch, first check already fully resolved -- still blocked.
        vm.expectRevert("RedoubtCoverPool: solvency check already performed this epoch");
        pool.checkSolvency();
    }

    // The positive case: once the epoch has actually advanced (via
    // settleEpoch, the same clock every other epoch-gated check in this
    // contract already uses), a fresh checkSolvency() call succeeds again.
    function test_checkSolvency_succeedsInLaterEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);

        pool.checkSolvency();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pool.pendingSolvencyResult());
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        pool.finalizeSolvencyCheck(cleartexts, decryptionProof);

        _advanceEpoch(pool); // currentEpoch 0 -> 1

        pool.checkSolvency();
        assertTrue(pool.solvencyCheckPending());
    }

    // The two gates (in-flight vs. rate-limit) are independent and both
    // must hold: with a decryption still pending, a second call in the
    // SAME epoch must hit the "already pending" revert first, not the
    // "already performed this epoch" one -- confirming neither gate
    // silently substitutes for the other.
    function test_checkSolvency_revertsWhilePendingEvenInSameEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);

        pool.checkSolvency();
        assertTrue(pool.solvencyCheckPending());

        vm.expectRevert("RedoubtCoverPool: solvency check already pending");
        pool.checkSolvency();
    }

    // §10 test #5 -- claim gating on oracle: reverts above the depeg
    // threshold, succeeds below it.
    function test_triggerClaimWindow_revertsWhenPriceAboveThreshold() public {
        // oracle starts at PEGGED_PRICE (1.00e8) > DEPEG_THRESHOLD (0.95e8).
        vm.expectRevert("RedoubtCoverPool: price not below depeg threshold");
        pool.triggerClaimWindow();
    }

    function test_triggerClaimWindow_succeedsWhenPriceBelowThreshold() public {
        oracle.setPrice(DEPEGGED_PRICE);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.ClaimWindowTriggered(0, DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        assertEq(uint256(pool.status()), uint256(RedoubtCoverPool.PoolStatus.ClaimWindowOpen));
    }

    // §11's stale-oracle guard, made concrete: an oracle that hasn't
    // updated in over MAX_ORACLE_STALENESS must not be trusted to open a
    // real, irreversible claim window, even if the last price it reported
    // was below the depeg threshold.
    function test_triggerClaimWindow_revertsWhenOraclePriceStale() public {
        oracle.setPrice(DEPEGGED_PRICE);
        vm.warp(block.timestamp + pool.maxOracleStaleness() + 1);

        vm.expectRevert("RedoubtCoverPool: oracle price stale");
        pool.triggerClaimWindow();
    }

    // §11 hardening item 3 regression check: maxOracleStaleness must be the
    // value actually threaded from the constructor argument, not a
    // hardcoded shadow left over from before it became a constructor param.
    // A pool deployed with a longer tolerance must tolerate a longer gap
    // that the shared `pool` fixture's 1-hour tolerance would have rejected.
    function test_triggerClaimWindow_respectsCustomMaxOracleStaleness() public {
        RedoubtCoverPool longTolerancePool = new RedoubtCoverPool(
            token,
            PREMIUM_RATE_BPS,
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            365 days,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );
        oracle.setPrice(DEPEGGED_PRICE);
        vm.warp(block.timestamp + 2 hours); // would revert under the 1-hour tolerance used elsewhere

        longTolerancePool.triggerClaimWindow();
        assertEq(uint256(longTolerancePool.status()), uint256(RedoubtCoverPool.PoolStatus.ClaimWindowOpen));
    }

    // §10 test #6 -- claim payout correctness: pays out the full encrypted
    // coverage, and no plaintext amount appears anywhere. ClaimPaid only
    // carries (holder, epoch); claim() has no return value at all; the
    // ERC-7984 ConfidentialTransfer event's amount field is an encrypted
    // euint64 handle, not a plaintext uint256.
    //
    // Real gap surfaced while writing this test, not a bug in claim()
    // itself (see §0 session 5 log): the pool's own token balance is only
    // ever funded by premiums (5% of coverage) via buyCover -- there is no
    // capital/reserve deposit mechanism anywhere in §9. With a single
    // buyer the pool would hold far less than the coverage owed, and
    // ERC-7984's FHESafeMath pattern does not revert on insufficient
    // balance -- it silently transfers 0 (`success=false`). Topping up the
    // pool's balance directly via the mock's unrestricted $_mint here
    // simulates capital the current design has no real way to provide,
    // purely so this test can exercise a genuine successful payout rather
    // than accidentally exercising the silent-zero-transfer gap instead.
    function test_claim_paysOutFullCoverageWithNoPlaintextAmount() public {
        // Uses BUYER2_PK, not the shared `buyer` field, deliberately --
        // `buyer` already has an incidental 1_000_000 mint from setUp()
        // for unrelated tests, which would make this test's balance math
        // depend on unrelated fixture state.
        address claimant = vm.addr(BUYER2_PK);
        uint64 coverageAmount = 100_000;
        uint64 premium = 5_000; // 5% of coverageAmount, per PREMIUM_RATE_BPS
        _buyCoverAs(BUYER2_PK, coverageAmount);
        token.$_mint(address(pool), coverageAmount);
        _advanceEpoch(pool); // clears MIN_HOLDING_EPOCHS

        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.prank(claimant);
        pool.claim();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pool.pendingClaimResult(claimant));
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        assertEq(cleartexts[0], 1);

        vm.expectEmit(true, true, false, true, address(pool));
        emit RedoubtCoverPool.ClaimPaid(claimant, 1); // epoch 1: _advanceEpoch rolled past epoch 0
        pool.finalizeClaim(claimant, cleartexts, decryptionProof);

        (, , bool claimed) = pool.policies(claimant);
        assertTrue(claimed);
        assertFalse(pool.claimDecryptionPending(claimant));

        // Pre-claim balance was coverageAmount - premium (paid in
        // buyCover); claim() pays out the full coverageAmount on top.
        bytes memory signature = signUserDecrypt(BUYER2_PK, address(token));
        uint256 finalBalance = userDecrypt(
            euint64.unwrap(token.confidentialBalanceOf(claimant)), claimant, address(token), signature
        );
        assertEq(finalBalance, uint256(coverageAmount) - premium + coverageAmount);
    }

    function test_claim_revertsWhenClaimWindowNotOpen() public {
        _buyCoverAs(BUYER_PK, 100_000);
        // Still Active -- triggerClaimWindow was never called.

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: claim window not open");
        pool.claim();
    }

    function test_claim_revertsOnSecondClaim() public {
        _buyCoverAs(BUYER_PK, 100_000);
        token.$_mint(address(pool), uint64(100_000)); // fund the pool so the claim genuinely succeeds
        _advanceEpoch(pool); // clears MIN_HOLDING_EPOCHS
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        bool fullyPaid = _claimAndFinalize(pool, buyer);
        assertTrue(fullyPaid);

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: already claimed");
        pool.claim();
    }

    // §0 session 6/7's flagged finding, closed the loop on: a claim
    // against an underfunded pool must not permanently lock the
    // policyholder into either "paid" or "blocked" -- confidentialTransfer
    // silently moves 0 rather than reverting, so without this fix
    // finalizeClaim would need to treat that as success. Confirms the
    // policy stays claimable and no liability is silently written off.
    function test_claim_staysClaimableAfterUnderfundedPayout() public {
        _buyCoverAs(BUYER_PK, 100_000);
        // Deliberately no top-up -- the pool's only balance is the 5%
        // premium (5_000) collected in buyCover, far short of the
        // 100_000 owed on a full claim.
        _advanceEpoch(pool); // clears MIN_HOLDING_EPOCHS
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        bool fullyPaid = _claimAndFinalize(pool, buyer);
        assertFalse(fullyPaid);

        (, , bool claimed) = pool.policies(buyer);
        assertFalse(claimed);
        assertFalse(pool.claimDecryptionPending(buyer));

        // Retryable: fund the pool properly and confirm claim() can be
        // called again and this time succeeds.
        token.$_mint(address(pool), uint64(100_000));
        bool retryFullyPaid = _claimAndFinalize(pool, buyer);
        assertTrue(retryFullyPaid);

        (, , bool claimedAfterRetry) = pool.policies(buyer);
        assertTrue(claimedAfterRetry);
    }

    // §11's decryption-race guard, per-policy this time rather than the
    // pool-wide singleton settleEpoch/checkSolvency use (§0 session 7):
    // a second claim() call for the same policy must not be able to fire
    // off a second confidentialTransfer while the first's outcome is
    // still unresolved.
    function test_claim_revertsWhileClaimDecryptionPending() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _advanceEpoch(pool); // clears MIN_HOLDING_EPOCHS
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.prank(buyer);
        pool.claim();
        assertTrue(pool.claimDecryptionPending(buyer));

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: claim decryption already pending");
        pool.claim();
    }

    // §0 session 13/14's moral-hazard mitigation, made concrete: coverage
    // bought in the same epoch a depeg is triggered in must not be
    // claimable. This closes the sharpest version of the gap (buying
    // cover in the last few minutes before a known depeg on insider
    // knowledge) -- it does NOT close the general "never held the coin at
    // all" case, which needs no waiting period to exploit.
    function test_claim_revertsWhenBoughtInCurrentEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);
        // No _advanceEpoch() here -- epochBought == currentEpoch == 0,
        // exactly the case this check exists to reject.
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: minimum holding period not elapsed");
        pool.claim();
    }

    // The positive case: a policy bought far enough in advance (one full
    // epoch, MIN_HOLDING_EPOCHS's minimum) claims exactly as before this
    // session's change -- the waiting period is a real gate, not one that
    // accidentally blocks legitimate long-standing coverage too.
    function test_claim_succeedsWhenBoughtEpochsBeforeClaimWindow() public {
        _buyCoverAs(BUYER_PK, 100_000);
        token.$_mint(address(pool), uint64(100_000)); // fund the pool so the claim genuinely succeeds
        _advanceEpoch(pool); // currentEpoch 0 -> 1, clearing MIN_HOLDING_EPOCHS

        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        bool fullyPaid = _claimAndFinalize(pool, buyer);
        assertTrue(fullyPaid);

        (, , bool claimed) = pool.policies(buyer);
        assertTrue(claimed);
    }

    // §0 session 9 -- the missing path to Settled. Reverts both before
    // ClaimWindowOpen has ever been entered and while it's open but the
    // duration hasn't elapsed yet.
    function test_settleClaimWindow_revertsBeforeClaimWindowOpen() public {
        // Still Active -- triggerClaimWindow was never called.
        vm.expectRevert("RedoubtCoverPool: claim window not open");
        pool.settleClaimWindow();
    }

    function test_settleClaimWindow_revertsBeforeDurationElapsed() public {
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.expectRevert("RedoubtCoverPool: claim window not yet closed");
        pool.settleClaimWindow();

        vm.warp(block.timestamp + CLAIM_WINDOW_DURATION - 1);
        vm.expectRevert("RedoubtCoverPool: claim window not yet closed");
        pool.settleClaimWindow();
    }

    // The window closing at exactly the right time, and only then: the
    // core positive case for §0 session 9's design (a fixed
    // claimWindowDuration off claimWindowOpenedAt).
    function test_settleClaimWindow_succeedsAfterDurationElapsed() public {
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();
        uint256 openedAt = pool.claimWindowOpenedAt();

        vm.warp(openedAt + CLAIM_WINDOW_DURATION);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.ClaimEpochSettled(0);
        pool.settleClaimWindow();

        assertEq(uint256(pool.status()), uint256(RedoubtCoverPool.PoolStatus.Settled));

        // Permissionless like every other transition function -- calling
        // it again once Settled must revert, not re-emit.
        vm.expectRevert("RedoubtCoverPool: claim window not open");
        pool.settleClaimWindow();
    }

    // Gated functions correctly rejecting calls after Settled: a fresh
    // claim() attempt (no policy previously in flight) must not succeed
    // once the pool has moved past ClaimWindowOpen.
    function test_claim_revertsAfterSettled() public {
        _buyCoverAs(BUYER_PK, 100_000);
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.warp(block.timestamp + CLAIM_WINDOW_DURATION);
        pool.settleClaimWindow();

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: claim window not open");
        pool.claim();
    }

    // The in-flight-claim edge case this session exists to close: a
    // claim() submitted WHILE the window was still open must remain
    // finalizable even after settleClaimWindow() has moved the pool to
    // Settled -- closing the window must cut off new claims, not strand
    // a decryption that was already pending when the deadline passed.
    // Against a design that (wrongly) gated finalizeClaim on
    // status == ClaimWindowOpen, this test would revert on the
    // finalizeClaim call below with a claim-window-not-open-style error
    // instead of resolving successfully.
    function test_finalizeClaim_resolvesInFlightClaimAfterSettled() public {
        _buyCoverAs(BUYER_PK, 100_000);
        token.$_mint(address(pool), uint64(100_000)); // fund the pool so the claim genuinely succeeds
        _advanceEpoch(pool); // clears MIN_HOLDING_EPOCHS
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        // Submitted while still open.
        vm.prank(buyer);
        pool.claim();
        assertTrue(pool.claimDecryptionPending(buyer));

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(pool.pendingClaimResult(buyer));
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);

        // Window closes while the decryption is still in flight.
        vm.warp(block.timestamp + CLAIM_WINDOW_DURATION);
        pool.settleClaimWindow();
        assertEq(uint256(pool.status()), uint256(RedoubtCoverPool.PoolStatus.Settled));

        // Must still resolve -- no status gate on finalizeClaim.
        vm.expectEmit(true, true, false, true, address(pool));
        emit RedoubtCoverPool.ClaimPaid(buyer, 1); // epoch 1: _advanceEpoch rolled past epoch 0
        pool.finalizeClaim(buyer, cleartexts, decryptionProof);

        assertFalse(pool.claimDecryptionPending(buyer));
        (, , bool claimed) = pool.policies(buyer);
        assertTrue(claimed);
    }

    // §11 hardening item 2: buyCover's confidentialTransferFrom call and
    // claim's confidentialTransfer call are both unavoidably followed by
    // state mutation that depends on the call's real (FHESafeMath) return
    // value -- a genuine CEI violation nonReentrant guards against, not a
    // reorderable one. These two tests exercise that guard against an
    // actually malicious premiumToken, rather than trusting the audit alone.
    // Both use a dedicated evil-token pool -- the shared `pool`/`token` from
    // setUp() stay untouched by these.

    // Reentrant call targets claim() again (as the token contract itself,
    // which is set up with its own real policy below) rather than buyCover,
    // since buyCover requires status == Active while claim requires
    // ClaimWindowOpen -- the two are mutually exclusive, so only a
    // same-function reentry is meaningful to test here.
    function test_claim_blocksReentrancyViaConfidentialTransfer() public {
        ReentrantERC7984Mock evilToken = new ReentrantERC7984Mock("Evil", "EVIL", "");
        RedoubtCoverPool evilPool = new RedoubtCoverPool(
            evilToken,
            PREMIUM_RATE_BPS,
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            MAX_ORACLE_STALENESS,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );

        // _buyCoverOnAs isn't usable here -- it hardcodes the shared `token`
        // from setUp(), not this test's evilToken as premiumToken.
        address buyerA = vm.addr(BUYER_PK);
        evilToken.$_mint(buyerA, uint64(100_000));
        vm.prank(buyerA);
        evilToken.setOperator(address(evilPool), uint48(block.timestamp + 1 days));
        (externalEuint64 buyerAHandle, bytes memory buyerAProof) =
            encryptUint64(100_000, buyerA, address(evilPool));
        vm.prank(buyerA);
        evilPool.buyCover(buyerAHandle, buyerAProof);

        // The malicious token contract also buys its own policy, so it has
        // a real, unclaimed policy to target when it reenters.
        evilToken.$_mint(address(evilToken), 50_000);
        vm.prank(address(evilToken));
        evilToken.setOperator(address(evilPool), uint48(block.timestamp + 1 days));
        (externalEuint64 selfHandle, bytes memory selfProof) =
            encryptUint64(50_000, address(evilToken), address(evilPool));
        vm.prank(address(evilToken));
        evilPool.buyCover(selfHandle, selfProof);

        _advanceEpoch(evilPool); // clears MIN_HOLDING_EPOCHS for both policies
        oracle.setPrice(DEPEGGED_PRICE);
        evilPool.triggerClaimWindow();

        // Arm reentry: when evilToken's confidentialTransfer runs (during
        // buyerA's payout below), attempt a second claim() as the token
        // contract itself.
        evilToken.setReentry(address(evilPool), abi.encodeCall(RedoubtCoverPool.claim, ()));

        vm.prank(buyerA);
        evilPool.claim();

        assertTrue(evilToken.attempted());
        assertFalse(evilToken.reentrancySucceeded());

        // buyerA's own claim still resolves normally afterward -- the
        // blocked reentrant attempt didn't corrupt or abort the outer call.
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(evilPool.pendingClaimResult(buyerA));
        (uint256[] memory cleartexts, bytes memory decryptionProof) = publicDecrypt(handles);
        evilPool.finalizeClaim(buyerA, cleartexts, decryptionProof);
        assertFalse(evilPool.claimDecryptionPending(buyerA));
    }

    function test_buyCover_blocksReentrancyViaConfidentialTransferFrom() public {
        ReentrantERC7984Mock evilToken = new ReentrantERC7984Mock("Evil", "EVIL", "");
        RedoubtCoverPool evilPool = new RedoubtCoverPool(
            evilToken,
            PREMIUM_RATE_BPS,
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            MAX_ORACLE_STALENESS,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );

        // Pre-compute a second valid encrypted input for the malicious
        // token contract itself as buyer, before arming reentry -- the
        // reentrant call's msg.sender will be evilToken itself, since it's
        // evilToken making the call.
        evilToken.$_mint(address(evilToken), 50_000);
        vm.prank(address(evilToken));
        evilToken.setOperator(address(evilPool), uint48(block.timestamp + 1 days));
        (externalEuint64 selfHandle, bytes memory selfProof) =
            encryptUint64(50_000, address(evilToken), address(evilPool));
        evilToken.setReentry(address(evilPool), abi.encodeCall(RedoubtCoverPool.buyCover, (selfHandle, selfProof)));

        // Buyer B's real, legitimate buyCover call triggers the reentry
        // attempt from inside evilToken's confidentialTransferFrom override.
        address buyerB = vm.addr(BUYER2_PK);
        evilToken.$_mint(buyerB, 100_000);
        vm.prank(buyerB);
        evilToken.setOperator(address(evilPool), uint48(block.timestamp + 1 days));
        (externalEuint64 handle, bytes memory proof) = encryptUint64(100_000, buyerB, address(evilPool));

        vm.prank(buyerB);
        evilPool.buyCover(handle, proof);

        assertTrue(evilToken.attempted());
        assertFalse(evilToken.reentrancySucceeded());

        // buyerB's own coverage was still credited normally afterward.
        (euint64 storedCoverage,,) = evilPool.policies(buyerB);
        bytes memory signature = signUserDecrypt(BUYER2_PK, address(evilPool));
        uint256 cleartext = userDecrypt(euint64.unwrap(storedCoverage), buyerB, address(evilPool), signature);
        assertEq(cleartext, 100_000);
    }

    // §11 hardening item 4: a decryption stuck past decryptionTimeout may be
    // abandoned via a permissionless abandon* function. See each contract
    // function's own comment for exactly what "abandon" does and does not
    // undo -- these tests exercise the mechanics: too-soon reverts, the
    // right state clears, nothing is double-counted, and the underlying
    // operation can be legitimately re-initiated afterward.

    function test_abandonStuckSettlement_revertsBeforeTimeout() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);
        _buyCoverAs(BUYER3_PK, 300_000);

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();
        assertTrue(pool.participantCountDecryptionPending());

        vm.expectRevert("RedoubtCoverPool: decryption timeout not yet elapsed");
        pool.abandonStuckSettlement();

        vm.warp(block.timestamp + DECRYPTION_TIMEOUT - 1);
        vm.expectRevert("RedoubtCoverPool: decryption timeout not yet elapsed");
        pool.abandonStuckSettlement();
    }

    // Stage 1 stuck: finalizeParticipantCount's KMS proof never arrives.
    // Abandoning must roll BOTH accumulators forward (identical to the
    // existing withhold branches) and leave the pool able to settle the
    // combined total normally in a later cycle -- nothing lost, nothing
    // revealed by the abandoned attempt.
    function test_abandonStuckSettlement_stage1_rollsForwardAndAllowsRetry() public {
        _buyCoverAs(BUYER_PK, 100_000); // premium 5_000
        _buyCoverAs(BUYER2_PK, 200_000); // premium 10_000
        _buyCoverAs(BUYER3_PK, 300_000); // premium 15_000
        uint256 expectedTotal = 30_000;

        vm.warp(block.timestamp + EPOCH_LENGTH);
        pool.settleEpoch();
        assertTrue(pool.participantCountDecryptionPending());

        vm.warp(block.timestamp + DECRYPTION_TIMEOUT);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.SettlementDecryptionAbandoned(0, 1);
        pool.abandonStuckSettlement();

        assertFalse(pool.participantCountDecryptionPending());
        assertEq(pool.settlementPendingSince(), 0);

        // A fresh cycle later settles the FULL original total -- nothing
        // was lost by abandoning the stuck one.
        vm.warp(block.timestamp + EPOCH_LENGTH);
        uint256 revealedTotal = _settleAndFinalize(pool);
        assertEq(revealedTotal, expectedTotal);
        assertEq(pool.publicReserves(), expectedTotal);
    }

    // Stage 3 stuck: finalizePremiumValueCheck already proceeded (the value
    // bit resolved true, marking the total decryptable), but
    // finalizePremiumSettlement's own KMS proof never arrives. Documents
    // the asymmetric rollback: only pendingPremiums is rolled forward, NOT
    // epochParticipantCount (already implicitly spent once the pipeline
    // proceeded past the count stage), and publicReserves must stay
    // untouched since this cycle never formalized its total.
    function test_abandonStuckSettlement_stage3_rollsForwardOnlyPremiums() public {
        _buyCoverAs(BUYER_PK, 100_000);
        _buyCoverAs(BUYER2_PK, 200_000);
        _buyCoverAs(BUYER3_PK, 300_000);

        // vm.roll alongside each vm.warp below -- this test's cumulative
        // FHE-op volume across two settlement cycles exceeds forge-fhevm's
        // per-block HCU budget if it all stays in one block; real
        // epoch/timeout gaps would naturally span many real blocks anyway.
        vm.warp(block.timestamp + EPOCH_LENGTH);
        vm.roll(block.number + 1);
        pool.settleEpoch();
        _finalizeParticipantCount(pool);
        assertTrue(pool.premiumValueCheckPending());

        bool valueOk = _finalizePremiumValueCheck(pool);
        assertTrue(valueOk);
        assertTrue(pool.premiumDecryptionPending());

        vm.warp(block.timestamp + DECRYPTION_TIMEOUT);
        vm.roll(block.number + 1);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.SettlementDecryptionAbandoned(0, 3);
        pool.abandonStuckSettlement();

        assertFalse(pool.premiumDecryptionPending());
        assertEq(pool.settlementPendingSince(), 0);
        assertEq(pool.publicReserves(), 0); // never formalized by this stuck cycle

        // epochParticipantCount was NOT rolled forward at stage 3 -- it was
        // already implicitly spent once finalizeParticipantCount decided to
        // proceed past the count stage (unlike pendingPremiums, rolled
        // forward via the exact same FHE.add line
        // test_abandonStuckSettlement_stage1_rollsForwardAndAllowsRetry
        // already proves preserves value). A bare follow-up cycle with NO
        // new buyers must therefore withhold again on headcount alone
        // (0 < MIN_EPOCH_PARTICIPANTS) -- proving the asymmetry directly,
        // rather than assuming it.
        vm.warp(block.timestamp + EPOCH_LENGTH);
        vm.roll(block.number + 1);
        pool.settleEpoch();

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.PremiumEpochWithheld(1, 0);
        uint256 count = _finalizeParticipantCount(pool);
        assertEq(count, 0);
    }

    function test_abandonStuckSolvencyCheck_revertsBeforeTimeout() public {
        _buyCoverAs(BUYER_PK, 100_000);
        pool.checkSolvency();
        assertTrue(pool.solvencyCheckPending());

        vm.expectRevert("RedoubtCoverPool: decryption timeout not yet elapsed");
        pool.abandonStuckSolvencyCheck();
    }

    // Abandoning a stuck solvency check must reset lastSolvencyCheckEpoch
    // back to the "never" sentinel -- the abandoned check's bit was never
    // finalized on-chain, so the once-per-epoch bracketing guard (§0
    // session 15) has nothing to protect against here, and a fresh check
    // must be initiable immediately, even in the same epoch.
    function test_abandonStuckSolvencyCheck_allowsFreshCheckInSameEpoch() public {
        _buyCoverAs(BUYER_PK, 100_000);
        pool.checkSolvency();
        assertEq(pool.lastSolvencyCheckEpoch(), 0);

        vm.warp(block.timestamp + DECRYPTION_TIMEOUT);

        vm.expectEmit(false, false, false, false, address(pool));
        emit RedoubtCoverPool.SolvencyCheckAbandoned();
        pool.abandonStuckSolvencyCheck();

        assertFalse(pool.solvencyCheckPending());
        assertEq(pool.solvencyCheckPendingSince(), 0);
        assertEq(pool.lastSolvencyCheckEpoch(), type(uint256).max);

        // Still epoch 0 -- would revert with "already performed this
        // epoch" if the sentinel reset above hadn't happened.
        pool.checkSolvency();
        assertTrue(pool.solvencyCheckPending());
    }

    function test_abandonStuckClaim_revertsBeforeTimeout() public {
        _buyCoverAs(BUYER_PK, 100_000);
        token.$_mint(address(pool), uint64(100_000));
        _advanceEpoch(pool);
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.prank(buyer);
        pool.claim();
        assertTrue(pool.claimDecryptionPending(buyer));

        vm.expectRevert("RedoubtCoverPool: decryption timeout not yet elapsed");
        pool.abandonStuckClaim(buyer);
    }

    // Abandoning a stuck claim must NOT let the holder retry: claim()'s
    // confidentialTransfer already executed synchronously (real funds
    // already moved or didn't, unconditionally, the moment claim() was
    // called) -- the KMS decryption getting stuck only means this contract
    // can't yet READ that already-fixed outcome, not that the outcome is
    // still undecided. Allowing a retry here would risk a second real
    // transfer of the same payoutAmount stacked on an already-successful
    // first one. abandonStuckClaim marks the policy claimed=true precisely
    // to foreclose that, so a subsequent claim() attempt must revert with
    // "already claimed" -- proven directly below, not just asserted.
    function test_abandonStuckClaim_forecloseRetryAfterTimeout() public {
        _buyCoverAs(BUYER_PK, 100_000);
        token.$_mint(address(pool), uint64(100_000));
        _advanceEpoch(pool);
        oracle.setPrice(DEPEGGED_PRICE);
        pool.triggerClaimWindow();

        vm.prank(buyer);
        pool.claim();

        vm.warp(block.timestamp + DECRYPTION_TIMEOUT);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RedoubtCoverPool.ClaimDecryptionAbandoned(buyer);
        pool.abandonStuckClaim(buyer);

        assertFalse(pool.claimDecryptionPending(buyer));
        (, , bool claimedAfterAbandon) = pool.policies(buyer);
        assertTrue(claimedAfterAbandon);

        vm.prank(buyer);
        vm.expectRevert("RedoubtCoverPool: already claimed");
        pool.claim();
    }
}
