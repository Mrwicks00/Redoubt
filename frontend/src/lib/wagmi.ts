import { createConfig, http, injected } from "wagmi";
import { REDOUBT_CHAIN } from "./contracts";

export const wagmiConfig = createConfig({
  chains: [REDOUBT_CHAIN],
  connectors: [injected()],
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
