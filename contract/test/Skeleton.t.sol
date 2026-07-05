// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {Skeleton} from "../src/Skeleton.sol";

/// @notice Toolchain smoke test only. Confirms FhevmTest host contracts
/// deploy locally and a basic encrypt -> call -> state flow works.
contract SkeletonTest is FhevmTest {
    Skeleton internal skeleton;

    function setUp() public override {
        super.setUp();
        skeleton = new Skeleton();
    }

    function test_setValue() public {
        (externalEuint64 handle, bytes memory proof) = encryptUint64(42, address(skeleton));
        skeleton.setValue(handle, proof);
    }
}
