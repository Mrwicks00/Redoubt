const { ethers } = require('ethers');
const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const cfg = require('./config');

async function getProvider() {
  const fetchRequest = new ethers.FetchRequest(cfg.RPC_URL);
  fetchRequest.timeout = 60_000;
  return new ethers.JsonRpcProvider(fetchRequest, undefined, { staticNetwork: true, batchMaxCount: 1 });
}

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`    [retry] ${label} attempt ${i + 1}/${attempts} failed: ${e.message || e}`);
    }
  }
  throw lastErr;
}

async function getWallets(provider) {
  return cfg.PRIVATE_KEYS.map((pk) => new ethers.Wallet(pk, provider));
}

let _instance;
async function getFhevmInstance() {
  if (!_instance) {
    _instance = await createInstance({ ...SepoliaConfig, network: cfg.RPC_URL });
  }
  return _instance;
}

function contracts(wallet) {
  return {
    pool: new ethers.Contract(cfg.POOL_ADDRESS, cfg.POOL_ABI, wallet),
    oracle: new ethers.Contract(cfg.ORACLE_ADDRESS, cfg.ORACLE_ABI, wallet),
    wrapper: new ethers.Contract(cfg.WRAPPER_ADDRESS, cfg.WRAPPER_ABI, wallet),
    underlying: new ethers.Contract(cfg.UNDERLYING_ADDRESS, cfg.ERC20_ABI, wallet),
  };
}

async function timed(label, fn) {
  const t0 = Date.now();
  console.log(`>>> ${label} ...`);
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`<<< ${label} done in ${ms}ms`);
  return { result, ms };
}

module.exports = { getProvider, getWallets, getFhevmInstance, contracts, timed, withRetry, cfg };
