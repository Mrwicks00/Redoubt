const { getProvider, getWallets, getFhevmInstance, contracts, timed, withRetry } = require('./client');

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

  console.log('publicReserves:', (await pool.publicReserves()).toString());

  await timed('checkSolvency()', () =>
    withRetry(async () => {
      const tx = await pool.checkSolvency();
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'checkSolvency'),
  );

  const handle = await pool.pendingSolvencyResult();
  console.log('pendingSolvencyResult handle:', handle);

  const { value, decryptionProof, ms } = await withRetry(
    () => publicDecryptOne(instance, handle),
    'publicDecrypt(solvency)',
  );
  console.log(`[TIMING] solvency ebool public decrypt latency: ${ms}ms, solvent=${value}`);

  const cleartext = value === true || value === 1n || value === 1 ? 1 : 0;

  await timed('finalizeSolvencyCheck()', () =>
    withRetry(async () => {
      const tx = await pool.finalizeSolvencyCheck([cleartext], decryptionProof);
      const r = await tx.wait();
      return { hash: tx.hash, gasUsed: r.gasUsed.toString() };
    }, 'finalizeSolvencyCheck'),
  );
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
