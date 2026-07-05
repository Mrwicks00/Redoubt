const { getProvider, getWallets, getFhevmInstance, contracts, timed, withRetry, cfg } = require('./client');

const DEPEG_PRICE = 94_000000n; // below 95_000000 depegThreshold (1e8 fixed point, 6 zero-padded here intentionally == 94_000000n means 94,000,000)

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
  const wallets = await getWallets(provider);
  const instance = await getFhevmInstance();
  const deployer = wallets[0];
  const { pool: poolAsDeployer, oracle } = contracts(deployer);

  await timed('oracle.setPrice(below depegThreshold)', () =>
    withRetry(async () => {
      const tx = await oracle.setPrice(DEPEG_PRICE);
      await tx.wait();
      return tx.hash;
    }, 'setPrice'),
  );

  await timed('triggerClaimWindow()', () =>
    withRetry(async () => {
      const tx = await poolAsDeployer.triggerClaimWindow();
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'triggerClaimWindow'),
  );

  console.log('claimWindowOpenedAt:', (await poolAsDeployer.claimWindowOpenedAt()).toString());
  console.log('claimWindowDuration:', (await poolAsDeployer.claimWindowDuration()).toString());

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const label = `buyer${i + 1} (${wallet.address})`;
    const { pool } = contracts(wallet);

    console.log(`\n=== ${label}: claim ===`);

    await timed(`${label}: claim()`, () =>
      withRetry(async () => {
        const tx = await pool.claim();
        const r = await tx.wait();
        return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
      }, 'claim'),
    );

    const handle = await poolAsDeployer.pendingClaimResult(wallet.address);
    console.log(`    pendingClaimResult handle: ${handle}`);

    const { value, decryptionProof, ms } = await withRetry(
      () => publicDecryptOne(instance, handle),
      `publicDecrypt(claim:${label})`,
    );
    console.log(`    [TIMING] claim fullyPaid ebool public decrypt latency: ${ms}ms, fullyPaid=${value}`);

    const cleartext = value === true || value === 1n || value === 1 ? 1 : 0;

    await timed(`${label}: finalizeClaim()`, () =>
      withRetry(async () => {
        const tx = await poolAsDeployer.finalizeClaim(wallet.address, [cleartext], decryptionProof);
        const r = await tx.wait();
        return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
      }, 'finalizeClaim'),
    );
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
