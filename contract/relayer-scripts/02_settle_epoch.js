const { ethers } = require('ethers');
const { getProvider, getWallets, getFhevmInstance, contracts, timed, withRetry } = require('./client');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilEpochEnds(pool) {
  const start = Number(await pool.epochStartTimestamp());
  const length = Number(await pool.epochLength());
  const target = start + length;
  const now = Math.floor(Date.now() / 1000);
  const waitSec = target - now + 5; // small buffer past the deadline
  if (waitSec > 0) {
    console.log(`Waiting ${waitSec}s (real time) for epochLength to elapse on-chain...`);
    await sleep(waitSec * 1000);
  }
}

async function publicDecryptOne(instance, handle) {
  const t0 = Date.now();
  const res = await instance.publicDecrypt([handle]);
  const ms = Date.now() - t0;
  const key = Object.keys(res.clearValues)[0];
  const value = res.clearValues[key];
  console.log(`    [TIMING] publicDecrypt(${handle}) resolved in ${ms}ms -> value=${value}`);
  return { value, decryptionProof: res.decryptionProof, ms };
}

async function main() {
  const provider = await getProvider();
  const [deployer] = await getWallets(provider);
  const instance = await getFhevmInstance();
  const { pool } = contracts(deployer);

  await waitUntilEpochEnds(pool);

  await timed('settleEpoch()', () =>
    withRetry(async () => {
      const tx = await pool.settleEpoch();
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'settleEpoch'),
  );

  const countHandle = await pool.participantCountAwaitingDecryption();
  console.log('participantCountAwaitingDecryption handle:', countHandle);

  const { value: count, decryptionProof: countProof, ms: countMs } = await withRetry(
    () => publicDecryptOne(instance, countHandle),
    'publicDecrypt(participantCount)',
  );
  console.log(`[TIMING] participant count public decrypt latency: ${countMs}ms, count=${count}`);

  await timed('finalizeParticipantCount()', () =>
    withRetry(async () => {
      const tx = await pool.finalizeParticipantCount([count], countProof);
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'finalizeParticipantCount'),
  );

  const premiumPending = await pool.premiumDecryptionPending();
  console.log('premiumDecryptionPending after finalizeParticipantCount:', premiumPending);

  if (premiumPending) {
    const premiumHandle = await pool.premiumsAwaitingDecryption();
    console.log('premiumsAwaitingDecryption handle:', premiumHandle);

    const { value: total, decryptionProof: premiumProof, ms: premiumMs } = await withRetry(
      () => publicDecryptOne(instance, premiumHandle),
      'publicDecrypt(premiumTotal)',
    );
    console.log(`[TIMING] premium total public decrypt latency: ${premiumMs}ms, total=${total}`);

    await timed('finalizePremiumSettlement()', () =>
      withRetry(async () => {
        const tx = await pool.finalizePremiumSettlement([total], premiumProof);
        const r = await tx.wait();
        return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
      }, 'finalizePremiumSettlement'),
    );

    console.log('publicReserves now:', (await pool.publicReserves()).toString());
  } else {
    console.log('Epoch was WITHHELD (below MIN_EPOCH_PARTICIPANTS) -- no premium reveal happened.');
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
