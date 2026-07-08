import { sepolia } from "wagmi/chains";
import RedoubtCoverPoolAbi from "./abi/RedoubtCoverPool.json";
import IERC7984Abi from "./abi/IERC7984.json";
import IPriceOracleAbi from "./abi/IPriceOracle.json";
import ERC20MockAbi from "./abi/ERC20Mock.json";
import IERC7984ERC20WrapperAbi from "./abi/IERC7984ERC20Wrapper.json";
import MockPriceOracleAbi from "./abi/MockPriceOracle.json";

// Sepolia deployment, redeployed for a fresh demo run — same contract logic
// as session 17's constructor signature, no code changes. Gives
// Active/currentEpoch()==0 state again.
export const REDOUBT_CHAIN = sepolia;

export const CONTRACTS = {
  redoubtCoverPool: "0x04f52feb042242Ec4913438988a034D7F4149dB9" as const,
  mockPriceOracle: "0x98051C5a2dfE791813bC10fd141C9Fa366B3BB1d" as const,
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
export const REDOUBT_COVER_POOL_DEPLOYMENT_BLOCK = BigInt(11_228_556);

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
