// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

// Owner-settable price, for locally simulating a depeg event in tests
// without a live feed (§9).
contract MockPriceOracle is IPriceOracle {
    address public immutable owner;

    uint64 private _price;
    uint256 private _lastUpdated;

    constructor(uint64 initialPrice) {
        owner = msg.sender;
        _price = initialPrice;
        _lastUpdated = block.timestamp;
    }

    function setPrice(uint64 newPrice) external {
        require(msg.sender == owner, "MockPriceOracle: not owner");
        _price = newPrice;
        _lastUpdated = block.timestamp;
    }

    function latestPrice() external view returns (uint64) {
        return _price;
    }

    function lastUpdated() external view returns (uint256) {
        return _lastUpdated;
    }
}
