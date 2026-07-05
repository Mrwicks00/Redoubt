require('dotenv').config({ path: '../.env' });
const { ethers } = require('ethers');
const { Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const cfg = require('./config');

const POOL_ADDRESS = '0x7E880F20B7dD8D307e150b0f59578c4eC20D193A';

async function main() {
  const fetchRequest = new ethers.FetchRequest(cfg.RPC_URL);
  fetchRequest.timeout = 60_000;
  const provider = new ethers.JsonRpcProvider(fetchRequest, undefined, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const [w1] = cfg.PRIVATE_KEYS.map((pk) => new ethers.Wallet(pk, provider));
  const instance = await createInstance({ ...SepoliaConfig, network: cfg.RPC_URL });
  const pool1 = new ethers.Contract(POOL_ADDRESS, cfg.POOL_ABI, w1);
  const policy = await pool1.policies(w1.address);
  const handle = policy[0];

  for (let i = 0; i < 3; i++) {
    const keypair = instance.generateKeypair();
    const startTimestamp = Math.floor(Date.now() / 1000);
    const durationDays = 1;
    const eip712 = instance.createEIP712(keypair.publicKey, [POOL_ADDRESS], startTimestamp, durationDays);
    const signature = await w1.signTypedData(
      eip712.domain,
      { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
      eip712.message,
    );
    const t0 = Date.now();
    const result = await instance.userDecrypt(
      [{ handle, contractAddress: POOL_ADDRESS }],
      keypair.privateKey,
      keypair.publicKey,
      signature,
      [POOL_ADDRESS],
      w1.address,
      startTimestamp,
      durationDays,
    );
    console.log(`[TIMING] userDecrypt run ${i + 1}: ${Date.now() - t0}ms (value=${result[handle]})`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
