// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

// Toolchain smoke test only. Not RedoubtCoverPool -- verifies that
// remappings/imports/inheritance for the fhevm solidity library resolve
// and compile before real logic is written.
contract Skeleton is ZamaEthereumConfig {
    euint64 private _value;

    function setValue(externalEuint64 handle, bytes calldata proof) external {
        _value = FHE.fromExternal(handle, proof);
        FHE.allowThis(_value);
    }
}
