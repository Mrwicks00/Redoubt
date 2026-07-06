import { createConfig, http, injected } from "wagmi";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { REDOUBT_CHAIN } from "./contracts";

// injected() covers desktop browser extensions (MetaMask, Rabby, ...) and
// wallet apps' own in-app browsers, neither of which exist on a plain
// mobile browser (no extension support, no window.ethereum). walletConnect()
// is what makes mobile work: it shows a wallet list that deep-links into
// the chosen wallet app instead of relying on injection.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [REDOUBT_CHAIN],
  // Disabled: wagmi's default EIP-6963 discovery turns every extension
  // installed in the browser (MetaMask, Rabby, Phantom, ...) into its own
  // connector, one button apiece. The UI wants exactly one "Connect wallet"
  // button, so injected() is the single desktop entry point regardless of
  // how many extensions are installed.
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId, showQrModal: true })]
      : []),
  ],
  transports: {
    [REDOUBT_CHAIN.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
