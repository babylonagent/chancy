import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App.jsx';

const txPayload = { to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0' };
const walletAddress = '0x9999999999999999999999999999999999999999';

describe('Chancy web client', () => {
  beforeEach(() => {
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
        if (method === 'eth_sendTransaction') return '0xabc';
        if (method === 'eth_call') return '0x0000000000000000000000000000000000000000000000000000000000000005';
        return null;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  it('renders 64 board tiles, wallet action, and controls', async () => {
    render(<App />);

    expect(await screen.findByText('Chancy')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /tile/i })).toHaveLength(64);
    expect(screen.getByLabelText(/difficulty/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(await screen.findByText(/Contract 0x1111…1111/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /build create session tx/i })).toBeInTheDocument();
  });

  it('connects an injected wallet and uses it as the player address', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    expect(await screen.findByRole('button', { name: /0x9999…9999/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue(walletAddress)).toBeInTheDocument();
  });

  it('builds create-session and click-tile transaction payloads from the API', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /build create session tx/i }));
    expect(await screen.findByText(/\/tx\/create-session/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/tx/click-tile', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/\/tx\/click-tile/)).toBeInTheDocument();
  });

  it('builds join, claim, and read payloads', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /build join tx/i }));
    expect(await screen.findByText(/\/tx\/join-session/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /build claim tx/i }));
    expect(await screen.findByText(/\/tx\/claim-rewards/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /build session read/i }));
    expect(await screen.findByText(/sessions/)).toBeInTheDocument();
  });

  it('simulates transactions, can send transactions when test mode is disabled, and runs reads through the wallet provider', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /build create session tx/i }));
    await screen.findByText(/\/tx\/create-session/);
    fireEvent.click(screen.getByRole('button', { name: /simulate with wallet/i }));

    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' })));
    expect(await screen.findByText(/simulation/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/wallet test mode/i));
    fireEvent.click(screen.getByRole('button', { name: /send with wallet/i }));

    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' })));
    expect(await screen.findByText(/0xabc/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /build session read/i }));
    await screen.findByText(/sessions/);
    fireEvent.click(screen.getByRole('button', { name: /run wallet read/i }));

    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' })));
    expect(await screen.findByText(/0005/)).toBeInTheDocument();
  });
});
