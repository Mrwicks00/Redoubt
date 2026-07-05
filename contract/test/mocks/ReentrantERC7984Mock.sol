// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ERC7984Mock} from "@openzeppelin/confidential-contracts/mocks/token/ERC7984Mock.sol";

// Test-only malicious premiumToken (§11 hardening item 2): overrides only
// the two non-`AndCall` euint64 overloads RedoubtCoverPool actually calls
// (confidentialTransferFrom for buyCover, confidentialTransfer for claim),
// attempting one reentrant call into a configured target before delegating
// to the real transfer logic. Guarded by `attempted` so arming this against
// an UNGUARDED pool (the regression-check direction) can't recurse forever
// -- one attempt is enough to prove the point either way.
contract ReentrantERC7984Mock is ERC7984Mock {
    address public reentryTarget;
    bytes public reentryCalldata;
    bool public attempted;
    bool public reentrancySucceeded;

    constructor(string memory name_, string memory symbol_, string memory tokenURI_)
        ERC7984Mock(name_, symbol_, tokenURI_)
    {}

    function setReentry(address target_, bytes calldata calldata_) external {
        reentryTarget = target_;
        reentryCalldata = calldata_;
    }

    function confidentialTransferFrom(address from, address to, euint64 amount)
        public
        override
        returns (euint64 transferred)
    {
        _attemptReentry();
        return super.confidentialTransferFrom(from, to, amount);
    }

    function confidentialTransfer(address to, euint64 amount) public override returns (euint64 transferred) {
        _attemptReentry();
        return super.confidentialTransfer(to, amount);
    }

    function _attemptReentry() internal {
        if (attempted || reentryTarget == address(0)) return;
        attempted = true;
        (bool ok,) = reentryTarget.call(reentryCalldata);
        reentrancySucceeded = ok;
    }
}
