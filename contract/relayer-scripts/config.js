require('dotenv').config({ path: '../.env' });

module.exports = {
  RPC_URL: process.env.SEPOLIA_RPC_URL,
  PRIVATE_KEYS: [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2, process.env.PRIVATE_KEY_3],

  POOL_ADDRESS: '0xF20a2bb9C47d98E2e22cEe6e8E824f88D6DbC584',
  ORACLE_ADDRESS: '0x233db038721156a154890842783ED9c372242f33',
  WRAPPER_ADDRESS: '0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639', // cUSDCMock
  UNDERLYING_ADDRESS: '0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF', // USDCMock

  MINT_AMOUNT: 200_000000n, // 200 USDCMock (6 decimals)
  WRAP_AMOUNT: 200_000000n, // wrap all of it
  COVERAGE_AMOUNT: 100_000000n, // 100 cUSDCMock coverage per buyer
};

const ERC20_ABI = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const WRAPPER_ABI = [
  'function wrap(address to, uint256 amount) external returns (bytes32)',
  'function setOperator(address operator, uint48 until) external',
  'function isOperator(address holder, address operator) view returns (bool)',
];

const ORACLE_ABI = [
  'function setPrice(uint64 newPrice) external',
  'function latestPrice() view returns (uint64)',
];

module.exports.ERC20_ABI = ERC20_ABI;
module.exports.WRAPPER_ABI = WRAPPER_ABI;
module.exports.ORACLE_ABI = ORACLE_ABI;
module.exports.POOL_ABI = require('../out/RedoubtCoverPool.sol/RedoubtCoverPool.json').abi;
