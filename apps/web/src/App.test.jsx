import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App.jsx';

const txPayload = { to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0' };
const walletAddress = '0x9999999999999999999999999999999999999999';

describe('Chancy web client', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/health') {
        return Response.json({ ok: true, service: 'chancy-api', contractAddress: txPayload.to });
      }
      if (url.startsWith('/tx/')) {
        return Response.json({ ...txPayload, route: url, body: JSON.parse(options.body || '{}') });
      }
      if (url.startsWith('/read/')) {
        return Response.json({ ...txPayload, decodeAs: 'sessions' });
      }
      return new Response('not found', { status: 404 });
    });

    window.ethereum = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'wallet_switchEthereumChain') return null;
        return null;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  it('renders the final product surface and first-run rules', async () => {
    render(<App />);

    expect(await screen.findByText('Open the board. Beat the bombs.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /reveal prizes before your third bomb/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /tile/i })).toHaveLength(64);
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /how chancy works/i })).toBeInTheDocument();
    expect(await screen.findByText(/API online/i)).toBeInTheDocument();
    expect(await screen.findByText(/Contract 0x1111…1111/i)).toBeInTheDocument();
  });

  it('dismisses and reopens the explanatory rules modal', async () => {
    render(<App />);
    await screen.findByText(/API online/i);

    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /how chancy works/i }));
    expect(screen.getByRole('dialog', { name: /reveal prizes before your third bomb/i })).toBeInTheDocument();
  });

  it('connects an injected wallet and uses it as the player address', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    expect(await screen.findByRole('button', { name: /0x9999…9999/i })).toBeInTheDocument();
    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_requestAccounts' })));
  });

  it('prepares create, fund, join, claim, and tile transactions through the API', async () => {
    render(<App />);
    await screen.findByText(/API online/i);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await screen.findByText(/Create room ready for wallet/);

    fireEvent.click(screen.getByRole('button', { name: /fund rewards/i }));
    await screen.findByText(/Fund rewards ready for wallet/);

    fireEvent.click(screen.getAllByRole('button', { name: /join room/i }).at(-1));
    await screen.findByText(/Board active/);

    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/tx/click-tile', expect.objectContaining({ method: 'POST' })));

    fireEvent.click(screen.getByRole('button', { name: /claim usdc/i }));
    await screen.findByText(/Claim USDC ready for wallet/);
  });

  it('updates room difficulty and keeps USDC fields visible', async () => {
    render(<App />);
    await screen.findByText(/API online/i);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    fireEvent.change(screen.getByLabelText(/difficulty/i), { target: { value: 'Hardcore' } });

    expect(screen.getByText(/One prize. Ten bombs/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/entry amount usdc/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reward per prize usdc/i)).toBeInTheDocument();
  });
});
