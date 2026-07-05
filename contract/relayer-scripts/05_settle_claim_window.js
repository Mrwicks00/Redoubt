const { getProvider, getWallets, contracts, timed, withRetry } = require('./client');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const provider = await getProvider();
  const [deployer] = await getWallets(provider);
  const { pool } = contracts(deployer);

  const openedAt = Number(await pool.claimWindowOpenedAt());
  const duration = Number(await pool.claimWindowDuration());
  const target = openedAt + duration;
  const now = Math.floor(Date.now() / 1000);
  const waitSec = target - now + 5;
  if (waitSec > 0) {
    console.log(`Waiting ${waitSec}s (real time) for claimWindowDuration to elapse on-chain...`);
    await sleep(waitSec * 1000);
  }

  await timed('settleClaimWindow()', () =>
    withRetry(async () => {
      const tx = await pool.settleClaimWindow();
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'settleClaimWindow'),
  );

  console.log('final status:', (await pool.status()).toString(), '(2 = Settled)');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
