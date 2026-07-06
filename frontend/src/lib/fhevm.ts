import type { EIP1193Provider } from "viem";
import type { FhevmInstance } from "@zama-fhe/relayer-sdk/web";

// Dynamic import (not a static top-level import) is required here: this
// module is pulled in (transitively, via "use client" components like
// buy-cover-card.tsx) by server-rendered pages such as app/app/page.tsx.
// A static import would make Next.js evaluate the SDK's browser-only code
// (which references the `self` global) during the server prerender pass,
// crashing with "ReferenceError: self is not defined". A dynamic import
// inside getFhevmInstance() defers that evaluation to when this function
// actually runs, which is only ever client-side (wallet-connect flows).
async function loadSdk() {
  return import("@zama-fhe/relayer-sdk/web");
}

// Browser-only counterpart to CLAUDE_HISTORY.md Session 10's Node harness
// (contract/relayer-scripts/client.js's getFhevmInstance). Two differences
// from that script, both confirmed against the installed package's own
// lib/web.d.ts rather than assumed:
//
// 1. The browser build (`@zama-fhe/relayer-sdk/web`) exports `initSDK()`,
//    which loads the TFHE/KMS WASM and a wasm-bindgen-rayon worker pool.
//    This must be awaited once before the first `createInstance()` call.
//    The Node build (`/node`, used by Session 10's scripts) has no such
//    export -- it initializes synchronously via native bindings -- so this
//    step is new territory this session, not a repeat of Session 10.
// 2. `network` is the connected wallet's own EIP-1193 provider
//    (`window.ethereum`), not a raw RPC URL string. Session 10's Node
//    scripts had no browser wallet and had to pass `cfg.RPC_URL` instead;
//    the app only ever offers wagmi's `injected()` connector
//    (connect-wallet.tsx), so `window.ethereum` already satisfies the
//    SDK's `Eip1193Provider` shape with nothing to adapt.
//
// Cached per provider instance (not just once globally) so a wallet/account
// switch doesn't silently keep using a stale instance -- cheap to key on
// object identity since wagmi's injected connector hands back the same
// `window.ethereum` object for the life of a connection.
let cachedProvider: EIP1193Provider | undefined;
let cachedInstance: Promise<FhevmInstance> | undefined;
let initPromise: Promise<boolean> | undefined;

export function getFhevmInstance(provider: EIP1193Provider): Promise<FhevmInstance> {
  if (cachedInstance && cachedProvider === provider) {
    return cachedInstance;
  }

  cachedProvider = provider;
  const attempt = (async () => {
    const sdk = await loadSdk();
    if (!initPromise) {
      initPromise = sdk.initSDK();
    }
    try {
      await initPromise;
    } catch (e) {
      // A failed initSDK() must not be cached forever -- the next caller
      // (e.g. a manual retry after a transient WASM-fetch failure) should
      // get a fresh attempt instead of the same rejected promise.
      initPromise = undefined;
      throw e;
    }
    return sdk.createInstance({ ...sdk.SepoliaConfig, network: provider });
  })();

  cachedInstance = attempt;
  attempt.catch(() => {
    if (cachedInstance === attempt) {
      cachedInstance = undefined;
      cachedProvider = undefined;
    }
  });

  return attempt;
}

// The relayer SDK's own userDecrypt EIP-712 request needs a validity window --
// `durationDays` is how long the signed authorization stays usable, not how
// long the decrypt itself takes. 1 day mirrors this session's own scratch
// verification script (contract/relayer-scripts/06_user_decrypt.js) -- a
// fresh signature is cheap to re-request, no reason to ask for longer.
export const USER_DECRYPT_DURATION_DAYS = 1;

type SignTypedDataAsync = (args: {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<`0x${string}`>;

// Shared EIP-712 user-decrypt dance for a single euint64 handle, extracted
// (session 21) so a second ciphertext (cUSDCMock's confidentialBalanceOf, in
// get-funds-card.tsx) doesn't need its own copy of this SDK-quirk logic --
// originally built session 19 for the pool's own coverage handle in
// my-coverage-card.tsx. `onPhase` lets each caller drive its own HUD log
// timeline instead of this helper owning any UI state.
export async function userDecryptEuint64({
  instance,
  handle,
  contractAddress,
  userAddress,
  signTypedDataAsync,
  onPhase,
}: {
  instance: FhevmInstance;
  handle: `0x${string}`;
  contractAddress: `0x${string}`;
  userAddress: `0x${string}`;
  signTypedDataAsync: SignTypedDataAsync;
  onPhase?: (phase: "signing" | "decrypting") => void;
}): Promise<bigint> {
  onPhase?.("signing");
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const eip712 = instance.createEIP712(
    keypair.publicKey,
    [contractAddress],
    startTimestamp,
    USER_DECRYPT_DURATION_DAYS
  );

  // eip712.message ships startTimestamp/durationDays as decimal STRINGS
  // (confirmed against the SDK's own source: createUserDecryptEIP712 does
  // `startTimestamp.toString()` internally) even though both are `uint256`
  // fields in the EIP-712 type. viem's signer requires an actual `bigint`
  // for uint256 fields, unlike ethers (used by the SDK's own reference CLI
  // script), which coerces strings implicitly -- passing the strings
  // through unchanged both fails to typecheck and, more importantly, is
  // the wrong runtime shape for viem's typed-data hashing. Verified this
  // exact BigInt-coerced signature is accepted by the real relayer (see
  // contract/relayer-scripts/08_verify_viem_signature.js, session 19).
  const signature = await signTypedDataAsync({
    domain: eip712.domain,
    types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    primaryType: "UserDecryptRequestVerification",
    message: {
      ...eip712.message,
      startTimestamp: BigInt(eip712.message.startTimestamp),
      durationDays: BigInt(eip712.message.durationDays),
    },
  });

  onPhase?.("decrypting");
  const result = await instance.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature,
    [contractAddress],
    userAddress,
    startTimestamp,
    USER_DECRYPT_DURATION_DAYS
  );

  const value = result[handle];
  return typeof value === "bigint" ? value : BigInt(value as string);
}

// Session 22: the OTHER real decrypt shape in this app -- distinct from
// userDecryptEuint64 above. finalizeClaim's `fullyPaid` ebool is marked
// via FHE.makePubliclyDecryptable (like checkSolvency/settleEpoch), not
// user-decrypt -- no EIP-712 signature, no wallet prompt, just a relayer
// round trip. Mirrors contract/relayer-scripts/04_claims.js's own
// publicDecryptOne + cleartext-coercion exactly, including reading the
// value back via Object.keys(...)[0] rather than indexing by our own
// `handle` string -- that script's defensive lookup is the only place
// this exact SDK response shape has been proven to work against the real
// relayer, so it's reused as-is rather than assumed to key by the input
// handle verbatim.
export async function publicDecryptBool(
  instance: FhevmInstance,
  handle: `0x${string}`
): Promise<{ value: boolean; cleartext: 0 | 1; decryptionProof: `0x${string}` }> {
  const res = await instance.publicDecrypt([handle]);
  const key = Object.keys(res.clearValues)[0] as `0x${string}` | undefined;
  const raw = key !== undefined ? res.clearValues[key] : undefined;
  const value = raw === true || raw === BigInt(1);
  return { value, cleartext: value ? 1 : 0, decryptionProof: res.decryptionProof };
}

// Session 23: the numeric counterpart to publicDecryptBool above, for the
// admin page's settlement pipeline -- finalizeParticipantCount decrypts a
// euint32 count and finalizePremiumSettlement decrypts a euint64 premium
// total, neither of which is a bit. Same defensive Object.keys(...)[0]
// lookup as publicDecryptBool (the only place this exact SDK response
// shape has been proven against the real relayer -- see
// contract/relayer-scripts/02_settle_epoch.js's own publicDecryptOne),
// just coerced to bigint instead of boolean.
export async function publicDecryptUint(
  instance: FhevmInstance,
  handle: `0x${string}`
): Promise<{ value: bigint; decryptionProof: `0x${string}` }> {
  const res = await instance.publicDecrypt([handle]);
  const key = Object.keys(res.clearValues)[0] as `0x${string}` | undefined;
  const raw = key !== undefined ? res.clearValues[key] : undefined;
  const value = typeof raw === "bigint" ? raw : BigInt(raw as string | number);
  return { value, decryptionProof: res.decryptionProof };
}
