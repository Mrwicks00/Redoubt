import { sepolia } from "wagmi/chains";
import RedoubtCoverPoolAbi from "./abi/RedoubtCoverPool.json";
import IERC7984Abi from "./abi/IERC7984.json";
import IPriceOracleAbi from "./abi/IPriceOracle.json";
import ERC20MockAbi from "./abi/ERC20Mock.json";
import IERC7984ERC20WrapperAbi from "./abi/IERC7984ERC20Wrapper.json";
import MockPriceOracleAbi from "./abi/MockPriceOracle.json";

// Sepolia deployment from CLAUDE_HISTORY.md Session 17 — a fresh instance of
// the session 15/16-hardened contract (new constructor params:
// maxOracleStaleness_, minEpochPremiumTotal_, decryptionTimeout_). Session
// 10's pool already reached PoolStatus.Settled during its own manual test
// run, so this redeploy gives Active/currentEpoch()==0 state again. Still no
// live buyCover/claim traffic against this address yet.
export const REDOUBT_CHAIN = sepolia;

export const CONTRACTS = {
  redoubtCoverPool: "0x7E880F20B7dD8D307e150b0f59578c4eC20D193A" as const,
  mockPriceOracle: "0xb7862C0bD3992CF66aAAe3cD6187adc072263bc4" as const,
  premiumToken: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639" as const, // cUSDCMock, unchanged from session 10
  // USDCMock, the registry pair's underlying token — confirmed session 21 via
  // the wrapper's own `underlying()` getter and independent bytecode/Etherscan
  // verification, not copied from the old scratch-script config on faith.
  underlyingToken: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF" as const,
};

// Session 22: the block RedoubtCoverPool was actually deployed at, read
// directly from contract/broadcast/DeployRedoubtCoverPool.s.sol/11155111/
// run-latest.json (not guessed) — lets the claim card scan ClaimPaid/
// ClaimDecryptionAbandoned logs from here instead of genesis, since
// `claimed` alone can't tell those two outcomes apart (see claim-card.tsx).
export const REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK = BigInt(11_207_403);

export const ABIS = {
  redoubtCoverPool: RedoubtCoverPoolAbi,
  ierc7984: IERC7984Abi,
  priceOracle: IPriceOracleAbi,
  erc20Mock: ERC20MockAbi,
  wrapper: IERC7984ERC20WrapperAbi,
  // Session 23: the mock oracle's OWN ABI (owner/setPrice), distinct from
  // IPriceOracle above (latestPrice/lastUpdated only) -- needed for the
  // admin page's ownership gate and price-control card, neither of which
  // is part of the IPriceOracle interface the pool itself reads.
  mockPriceOracle: MockPriceOracleAbi,
} as const;

// Mirrors the contract's PoolStatus enum (RedoubtCoverPool.sol) exactly —
// keep in sync if the enum ever changes.
export const POOL_STATUS = ["Active", "ClaimWindowOpen", "Settled"] as const;
export type PoolStatusLabel = (typeof POOL_STATUS)[number];
