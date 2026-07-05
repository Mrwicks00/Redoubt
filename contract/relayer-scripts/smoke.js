const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const { ethers } = require('ethers');
require('dotenv').config({ path: '../.env' });

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const poolAddress = '0xF20a2bb9C47d98E2e22cEe6e8E824f88D6DbC584';

  console.log('Creating FHEVM instance for Sepolia...');
  const t0 = Date.now();
  const instance = await createInstance({
    ...SepoliaConfig,
    network: process.env.SEPOLIA_RPC_URL,
  });
  console.log(`Instance created in ${Date.now() - t0}ms`);

  console.log('Building encrypted input (coverage = 100_000000, i.e. 100 cUSDCMock)...');
  const t1 = Date.now();
  const input = instance.createEncryptedInput(poolAddress, wallet.address);
  input.add64(100_000000n);
  const encrypted = await input.encrypt();
  console.log(`Encrypted + KMS input-proof obtained in ${Date.now() - t1}ms`);
  console.log('handle:', ethers.hexlify(encrypted.handles[0]));
  console.log('proof length (bytes):', encrypted.inputProof.length);
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED');
  console.error(e);
  process.exit(1);
});
