// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {RedoubtCoverPool} from "../src/RedoubtCoverPool.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";

// Sepolia deploy script (§12). premiumToken is NOT deployed here -- it is a
// real, already-deployed ERC-7984 wrapper pulled from Zama's Confidential
// Token Wrappers Registry (0x2f0750Bbb0A246059d80e94c454586a7F27a128e on
// Sepolia), independently verified on-chain before use (registry bytecode
// inspected, getTokenConfidentialTokenPairsSlice() queried directly,
// isConfidentialTokenValid() confirmed true) rather than trusting any single
// source blindly -- see CLAUDE_HISTORY.md for the verification trail.
//
// Registered pair used: underlying USDCMock (6 decimals) <-> wrapper
// "Confidential USDC (Mock)" / cUSDCMock (6 decimals), both real Sepolia
// contracts, not fabricated addresses.
contract DeployRedoubtCoverPool is Script {
    address constant PREMIUM_TOKEN = 0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639; // cUSDCMock wrapper

    // Demo/manual-verification-scale parameters -- deliberately short so this
    // session can exercise settleEpoch/settleClaimWindow's real-time deadlines
    // (no vm.warp on a live chain) without waiting hours. NOT a production
    // recommendation -- §9's own example used epochLength on the order of
    // days. Documented here rather than silently picked so the gap is visible.
    uint256 constant PREMIUM_RATE_BPS = 500; // 5%
    uint256 constant EPOCH_LENGTH = 5 minutes;
    uint256 constant CLAIM_WINDOW_DURATION = 5 minutes;

    // §0 session 15 mitigation for the thin-value sybil gap: minimum total
    // premiums (cUSDCMock's own 6-decimal units, i.e. 5 USDC) an epoch must
    // clear, in addition to MIN_EPOCH_PARTICIPANTS, before its total is
    // ever revealed. Sized relative to session 10's own real demo numbers
    // (3 real buyers at PREMIUM_RATE_BPS=500 produced a 15 USDC total) --
    // 5 USDC is low enough not to block a genuine small demo, but high
    // enough that 3 sybil addresses each padding with a few cents of
    // dust premium (a cent or two each, well under $1 total) would not
    // clear it. Demo-scale, like EPOCH_LENGTH/CLAIM_WINDOW_DURATION above
    // -- a production deployment should recalibrate against its own real
    // expected premium volume, not copy this number.
    uint256 constant MIN_EPOCH_PREMIUM_TOTAL = 5_000_000;

    // 1e8 fixed point (IPriceOracle). Peg assumed at 1.00; threshold is a 5%
    // depeg, a common real-world stablecoin depeg trigger definition.
    uint64 constant INITIAL_PRICE = 100_000_000;
    uint64 constant DEPEG_THRESHOLD = 95_000_000;

    // §11 hardening item 3: demo-scale like EPOCH_LENGTH/CLAIM_WINDOW_DURATION
    // above -- long enough to tolerate this demo's own oracle update cadence,
    // short enough that a stale price can't be weaponized. A production
    // deployment with day-scale epochs should use a larger value.
    uint256 constant MAX_ORACLE_STALENESS = 1 hours;

    // §11 hardening item 4: day-scale, comfortably beyond session 10's own
    // measured worst-case real latency (~28-50s encrypt, ~3.3-3.6s decrypt)
    // -- see RedoubtCoverPool.sol's decryptionTimeout declaration.
    uint256 constant DECRYPTION_TIMEOUT = 1 days;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        MockPriceOracle oracle = new MockPriceOracle(INITIAL_PRICE);
        console.log("MockPriceOracle deployed at:", address(oracle));

        RedoubtCoverPool pool = new RedoubtCoverPool(
            IERC7984(PREMIUM_TOKEN),
            PREMIUM_RATE_BPS,
            EPOCH_LENGTH,
            oracle,
            DEPEG_THRESHOLD,
            MAX_ORACLE_STALENESS,
            CLAIM_WINDOW_DURATION,
            MIN_EPOCH_PREMIUM_TOTAL,
            DECRYPTION_TIMEOUT
        );
        console.log("RedoubtCoverPool deployed at:", address(pool));
        console.log("premiumToken (cUSDCMock):", PREMIUM_TOKEN);

        vm.stopBroadcast();
    }
}
