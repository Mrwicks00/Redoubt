require('dotenv').config({ path: '../.env' });
const { ethers } = require('ethers');
const { Agent, setGlobalDispatcher } = require('undici');

// Genuinely NEW connectivity finding this session, distinct from session 10's
// IPv6-DNS-ordering fix (NODE_OPTIONS=--dns-result-order=ipv4first). That flag
// only reorders Node's dns.lookup() results and does nothing for undici's own
// fetch implementation. In this sandbox IPv6 is unreachable (ENETUNREACH) but
// undici's happy-eyeballs connection logic still stalls past its own timeout
// before falling back to IPv4 -- plain curl reaches the same IPv4 address in
// ~1s. The fix that actually works: force IPv4 at the connection layer via a
// custom undici Agent, set as the global dispatcher before the relayer SDK
// (which uses undici's fetch internally on Node) does any network I/O.
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const cfg = require('./config');

// Session 17's redeployed pool -- config.js still points at session 10's
// original (now-Settled) pool, deliberately left untouched since 01-05 replay
// that historical flow. This script targets the current live pool instead.
const POOL_ADDRESS = '0x7E880F20B7dD8D307e150b0f59578c4eC20D193A';
const WRAPPER_ADDRESS = cfg.WRAPPER_ADDRESS; // cUSDCMock, unchanged since session 10
const UNDERLYING_ADDRESS = cfg.UNDERLYING_ADDRESS;

async function main() {
  const fetchRequest = new ethers.FetchRequest(cfg.RPC_URL);
  fetchRequest.timeout = 60_000;
  const provider = new ethers.JsonRpcProvider(fetchRequest, undefined, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const [w1, w2] = cfg.PRIVATE_KEYS.map((pk) => new ethers.Wallet(pk, provider));

  console.log('Creating FHEVM instance...');
  const instance = await createInstance({ ...SepoliaConfig, network: cfg.RPC_URL });

  const pool1 = new ethers.Contract(POOL_ADDRESS, cfg.POOL_ABI, w1);
  const wrapper1 = new ethers.Contract(WRAPPER_ADDRESS, cfg.WRAPPER_ABI, w1);
  const underlying1 = new ethers.Contract(UNDERLYING_ADDRESS, cfg.ERC20_ABI, w1);

  let policy = await pool1.policies(w1.address);
  console.log(`wallet1 (${w1.address}) existing coverage handle:`, policy[0]);

  if (policy[0] === ethers.ZeroHash) {
    console.log('\nNo policy yet -- funding + buying cover on the session-17 pool...');
    let tx = await underlying1.mint(w1.address, 200_000000n);
    await tx.wait();
    console.log('minted underlying');
    tx = await underlying1.approve(WRAPPER_ADDRESS, 200_000000n);
    await tx.wait();
    console.log('approved wrapper');
    tx = await wrapper1.wrap(w1.address, 200_000000n);
    await tx.wait();
    console.log('wrapped -> cUSDCMock');
    const until = Math.floor(Date.now() / 1000) + 86400;
    tx = await wrapper1.setOperator(POOL_ADDRESS, until);
    await tx.wait();
    console.log('granted operator to pool');

    const t0 = Date.now();
    const input = instance.createEncryptedInput(POOL_ADDRESS, w1.address);
    input.add64(100_000000n);
    const encrypted = await input.encrypt();
    console.log(`built encrypted input in ${Date.now() - t0}ms`);

    tx = await pool1.buyCover(ethers.hexlify(encrypted.handles[0]), ethers.hexlify(encrypted.inputProof));
    await tx.wait();
    console.log('buyCover() mined');

    policy = await pool1.policies(w1.address);
    console.log('policy now:', policy[0]);
  }

  const handle = policy[0];

  // ---- Real userDecrypt timing: the actual policyholder (correct signer) ----
  console.log('\n=== userDecrypt as the correct policyholder ===');
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip712 = instance.createEIP712(keypair.publicKey, [POOL_ADDRESS], startTimestamp, durationDays);
  const signature = await w1.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );

  const t1 = Date.now();
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
  const ms1 = Date.now() - t1;
  console.log(`[TIMING] userDecrypt (correct signer): ${ms1}ms`);
  console.log('cleartext coverage:', result[handle].toString());

  // ---- Wrong-signer case: wallet2 has no policy / no ACL grant on this handle ----
  console.log('\n=== userDecrypt as a third party with no ACL grant on this handle ===');
  const keypair2 = instance.generateKeypair();
  const eip712b = instance.createEIP712(keypair2.publicKey, [POOL_ADDRESS], startTimestamp, durationDays);
  const signature2 = await w2.signTypedData(
    eip712b.domain,
    { UserDecryptRequestVerification: eip712b.types.UserDecryptRequestVerification },
    eip712b.message,
  );

  const t2 = Date.now();
  try {
    const result2 = await instance.userDecrypt(
      [{ handle, contractAddress: POOL_ADDRESS }],
      keypair2.privateKey,
      keypair2.publicKey,
      signature2,
      [POOL_ADDRESS],
      w2.address,
      startTimestamp,
      durationDays,
    );
    console.log(`[WRONG SIGNER] resolved (no throw) in ${Date.now() - t2}ms:`, result2);
  } catch (e) {
    console.log(`[WRONG SIGNER] threw after ${Date.now() - t2}ms:`, e.message);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
