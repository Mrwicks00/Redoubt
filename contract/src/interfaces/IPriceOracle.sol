// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

// Deliberately plaintext, not encrypted (§9): the depeg trigger must be a
// fact anyone can verify without any decryption step.
interface IPriceOracle {
    /// @notice Latest price, as a 1e8 fixed-point value.
    function latestPrice() external view returns (uint64);

    /// @notice Timestamp of the last price update. Lets callers reject a
    /// stale price rather than trusting an oracle that hasn't updated in
    /// a long time (§11).
    function lastUpdated() external view returns (uint256);
}
