// Verifies the EXACT signing path the browser component will use (viem's
// signTypedData with startTimestamp/durationDays coerced to BigInt, since the
// SDK's own eip712.message ships them as decimal strings -- confirmed via
// createUserDecryptEIP712's `startTimestamp.toString()` in the SDK's own
// source) actually produces a signature the real relayer accepts. Not a type-
// checker satisfaction exercise -- a functional correctness check.
require('dotenv').config({ path: '../.env' });
const { ethers } = require('ethers');
const { Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const { privateKeyToAccount } = require('viem/accounts');
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
  const account = privateKeyToAccount(cfg.PRIVATE_KEYS[0]);
  console.log('ethers wallet:', w1.address, ' viem account:', account.address);

  const instance = await createInstance({ ...SepoliaConfig, network: cfg.RPC_URL });
  const pool1 = new ethers.Contract(POOL_ADDRESS, cfg.POOL_ABI, w1);
  const policy = await pool1.policies(w1.address);
  const handle = policy[0];
  console.log('handle:', handle);

  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip712 = instance.createEIP712(keypair.publicKey, [POOL_ADDRESS], startTimestamp, durationDays);

  console.log('raw message from SDK:', eip712.message, 'typeof startTimestamp:', typeof eip712.message.startTimestamp);

  // This is the exact shape the my-coverage-card.tsx component builds.
  const signature = await account.signTypedData({
    domain: eip712.domain,
    types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    primaryType: 'UserDecryptRequestVerification',
    message: {
      ...eip712.message,
      startTimestamp: BigInt(eip712.message.startTimestamp),
      durationDays: BigInt(eip712.message.durationDays),
    },
  });

  console.log('viem signature:', signature);

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
  console.log(`ACCEPTED in ${Date.now() - t0}ms. cleartext:`, result[handle].toString());
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
