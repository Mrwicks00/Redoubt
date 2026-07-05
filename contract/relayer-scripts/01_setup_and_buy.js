const { ethers } = require('ethers');
const { getProvider, getWallets, getFhevmInstance, contracts, timed, withRetry, cfg } = require('./client');

async function main() {
  const provider = await getProvider();
  const wallets = await getWallets(provider);
  const instance = await getFhevmInstance();

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const label = `buyer${i + 1} (${wallet.address})`;
    const { underlying, wrapper, pool } = contracts(wallet);

    console.log(`\n=== ${label} ===`);

    await timed(`${label}: mint ${cfg.MINT_AMOUNT} underlying`, () =>
      withRetry(async () => {
        const tx = await underlying.mint(wallet.address, cfg.MINT_AMOUNT);
        await tx.wait();
        return tx.hash;
      }, 'mint'),
    );

    await timed(`${label}: approve wrapper`, () =>
      withRetry(async () => {
        const tx = await underlying.approve(cfg.WRAPPER_ADDRESS, cfg.WRAP_AMOUNT);
        await tx.wait();
        return tx.hash;
      }, 'approve'),
    );

    await timed(`${label}: wrap -> cUSDCMock`, () =>
      withRetry(async () => {
        const tx = await wrapper.wrap(wallet.address, cfg.WRAP_AMOUNT);
        await tx.wait();
        return tx.hash;
      }, 'wrap'),
    );

    await timed(`${label}: setOperator(pool)`, () =>
      withRetry(async () => {
        const until = Math.floor(Date.now() / 1000) + 86400;
        const tx = await wrapper.setOperator(cfg.POOL_ADDRESS, until);
        await tx.wait();
        return tx.hash;
      }, 'setOperator'),
    );

    const { result: encrypted, ms: encryptMs } = await timed(
      `${label}: build encrypted input + real KMS input-proof (coverage=${cfg.COVERAGE_AMOUNT})`,
      () =>
        withRetry(async () => {
          const input = instance.createEncryptedInput(cfg.POOL_ADDRESS, wallet.address);
          input.add64(cfg.COVERAGE_AMOUNT);
          return input.encrypt();
        }, 'encrypt'),
    );
    console.log(`    [TIMING] input-proof generation: ${encryptMs}ms`);

    await timed(`${label}: buyCover()`, () =>
      withRetry(async () => {
        const tx = await pool.buyCover(ethers.hexlify(encrypted.handles[0]), ethers.hexlify(encrypted.inputProof));
        const receipt = await tx.wait();
        return { hash: tx.hash, gasUsed: receipt.gasUsed.toString() };
      }, 'buyCover'),
    );
  }

  console.log('\nAll 3 buyers completed buyCover(). Current epoch state:');
  const { pool } = contracts(wallets[0]);
  console.log('currentEpoch:', (await pool.currentEpoch()).toString());
  console.log('epochStartTimestamp:', (await pool.epochStartTimestamp()).toString());
  console.log('epochLength:', (await pool.epochLength()).toString());
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
