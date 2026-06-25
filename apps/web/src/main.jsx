import React from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider, useAccount, useDisconnect } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppKit, useAppKit, useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base } from 'viem/chains';

import App from './App.jsx';
import './styles.css';

// ─── REOWN APPKIT CONFIG ────────────────────────────────────────────────────
const PROJECT_ID = 'b6af60317a6f1fc61c5ad130fc80b4d7';
const networks = [base];

const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId: PROJECT_ID,
  ssr: false,
});
const wagmiConfig = wagmiAdapter.wagmiConfig;

const metadata = {
  name: 'Chancy',
  description: 'Trustless P2P tile-reveal game on Base',
  url: 'https://chancy.cash',
  icons: ['https://chancy.cash/assets/chancy-logo.svg'],
};

// Create the modal ONCE — this registers the connect button behavior
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  metadata,
  projectId: PROJECT_ID,
  features: {
    analytics: false,
    email: true,
    socials: ['google', 'apple', 'x'],
    emailShowWallets: true,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-color-mix': '#1a1a2e',
    '--w3m-color-mix-amount': 100,
    '--w3m-accent': '#d4a017',
  },
});

const queryClient = new QueryClient();

// Wrapper that provides wallet context to App via props
function WalletWrapper({ children }) {
  const { open } = useAppKit();
  const { isConnected, address } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider();
  const { disconnect } = useDisconnect();

  // Inject wallet functions into children via context
  return children({
    open,           // () => opens Reown modal
    isConnected,    // boolean
    address,        // string | undefined
    walletProvider, // EIP1193 provider for txs
    disconnect,     // () => disconnects wallet
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletWrapper>
          {(wallet) => <App wallet={wallet} />}
        </WalletWrapper>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
