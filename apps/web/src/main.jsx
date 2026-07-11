import React, { useEffect, useState } from 'react';
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

// ─── FARCASTER CONTEXT HOOK ─────────────────────────────────────────────────
// Detects if we're inside a Farcaster Mini App.
// Non-blocking: starts in "unknown" mode, resolves within 2s.
// Does NOT block on eth_requestAccounts — that can hang if the wallet
// popup doesn't appear. The provider is set up immediately; account
// requests happen lazily.
function useFarcasterContext() {
  const [state, setState] = useState({
    isMiniApp: false,
    checking: true,
    sdk: null,
    user: null,
    ethProvider: null,
    address: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timeoutId;

    // Hard timeout: if detection doesn't complete in 2s, fall back to web mode.
    // This prevents the black-screen-on-hang issue.
    timeoutId = setTimeout(() => {
      if (!cancelled) {
        setState({ isMiniApp: false, checking: false, sdk: null, user: null, ethProvider: null, address: null });
      }
    }, 2000);

    (async () => {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk');
        // isInMiniApp has a built-in 100ms timeout — fast
        const inMini = await sdk.isInMiniApp();

        if (cancelled) return;

        if (inMini) {
          // Get the EIP-1193 provider — this is fast
          const ethProvider = await sdk.wallet.getEthereumProvider();
          const user = sdk.context?.user || null;

          // Set up mini app mode immediately — don't block on account request
          setState({
            isMiniApp: true,
            checking: false,
            sdk,
            user,
            ethProvider,
            address: null, // Will be requested lazily
          });

          // Signal ready to hide Farcaster splash
          sdk.actions.ready().catch(() => {});

          // Request account in background — don't hang the app if it fails
          try {
            const accounts = await Promise.race([
              ethProvider.request({ method: 'eth_requestAccounts' }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            if (!cancelled && accounts?.[0]) {
              setState((prev) => ({ ...prev, address: accounts[0] }));
            }
          } catch (e) {
            // Account request failed or timed out — app will show "Connect" fallback
          }

          clearTimeout(timeoutId);
        } else {
          if (!cancelled) {
            setState({ isMiniApp: false, checking: false, sdk: null, user: null, ethProvider: null, address: null });
          }
          clearTimeout(timeoutId);
        }
      } catch (e) {
        // SDK failed to load — fall back to web mode
        if (!cancelled) {
          setState({ isMiniApp: false, checking: false, sdk: null, user: null, ethProvider: null, address: null });
        }
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);

  return state;
}

// ─── REOWN WALLET WRAPPER (web mode) ────────────────────────────────────────
function ReownWalletWrapper({ children }) {
  const { open } = useAppKit();
  const { isConnected, address } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider();
  const { disconnect } = useDisconnect();

  return children({
    open,
    isConnected,
    address,
    walletProvider,
    disconnect,
  });
}

// ─── FARCASTER WALLET WRAPPER (mini app mode) ───────────────────────────────
// Produces the same 5-field wallet interface as Reown, but sourced from
// the Farcaster SDK's built-in EIP-1193 provider.
function FarcasterWalletWrapper({ fc, children }) {
  // If we have a provider but no address yet, try to connect on mount
  const [addr, setAddr] = useState(fc.address);

  useEffect(() => {
    if (fc.ethProvider && !addr) {
      fc.ethProvider.request({ method: 'eth_requestAccounts' })
        .then((accounts) => { if (accounts?.[0]) setAddr(accounts[0]); })
        .catch(() => {});
    }
  }, [fc.ethProvider]);

  const wallet = {
    open: () => {
      // If someone clicks "connect" in Farcaster mode, try requesting accounts
      if (fc.ethProvider) {
        fc.ethProvider.request({ method: 'eth_requestAccounts' })
          .then((accounts) => { if (accounts?.[0]) setAddr(accounts[0]); })
          .catch(() => {});
      }
    },
    isConnected: !!addr,
    address: addr,
    walletProvider: fc.ethProvider,
    disconnect: () => {},
  };

  return children(wallet);
}

// ─── ROOT: decide which wallet source to use ────────────────────────────────
function Root() {
  const fc = useFarcasterContext();

  // While detecting context, show a minimal loading splash (not a black screen)
  // This is very brief — isInMiniApp resolves in ~100ms, SDK import ~200ms
  if (fc.checking) {
    return (
      <div style={{
        background: '#08080c', minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIzMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZiODAwIiBzdHJva2Utd2lkdGg9IjQiIG9wYWNpdHk9IjAuMyIvPjwvc3ZnPg==" alt="Chancy" style={{ width: 64, height: 64, opacity: 0.3 }} />
      </div>
    );
  }

  const farcasterProps = fc.isMiniApp ? {
    farcaster: {
      user: fc.user,
      sdk: fc.sdk,
    },
  } : { farcaster: null };

  if (fc.isMiniApp) {
    return (
      <FarcasterWalletWrapper fc={fc}>
        {(wallet) => <App wallet={wallet} {...farcasterProps} />}
      </FarcasterWalletWrapper>
    );
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ReownWalletWrapper>
          {(wallet) => <App wallet={wallet} {...farcasterProps} />}
        </ReownWalletWrapper>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
