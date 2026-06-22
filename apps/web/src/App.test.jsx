import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App.jsx';

const txPayload = { to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0x0' };
const walletAddress = '0x9999999999999999999999999999999999999999';
const txHash = '0x' + 'aa'.repeat(32);

function closeRules() {
  fireEvent.click(screen.getByRole('button', { name: /got it/i }));
}

describe('Chancy V2 credit client', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.overflow = '';
    global.fetch = vi.fn(async (url, options = {}) => {
      const method = options.method || 'GET';
      if (url === '/health') return Response.json({ ok: true, service: 'chancy-api', contractAddress: txPayload.to });
      if (url.startsWith('/v2/tx/')) return Response.json({ ...txPayload, route: url });
      if (url === '/v2/credits/deposit') return Response.json({ player: walletAddress, balance: '4750000', asset: 'USD_CREDIT', credited: '4750000', txHash, idempotent: false });
      if (url.startsWith('/v2/credits/')) return Response.json({ player: walletAddress, balance: '4750000', withdrawable: '4750000' });
      if (url === '/v2/sessions') return Response.json({ sessionId: '1', player: walletAddress, host: walletAddress, mode: 'Normal', stake: '50000', boardCommitHash: '0xdead', status: 'active' });
      if (/\/v2\/sessions\/\d+\/click/.test(url)) {
        const body = JSON.parse(options.body || '{}');
        return Response.json({ sessionId: '1', tile: body.tile, outcome: 'empty', bombsHit: 0, prizesCollected: 0, status: 'active', payout: '0' });
      }
      if (/\/v2\/sessions\/\d+\/exit/.test(url)) {
        return Response.json({ sessionId: '1', status: 'exited', payout: '0', board: { bombPositions: [3, 9], prizePositions: [42, 55] }, clicked: [] });
      }
      if (url === '/v2/withdrawals/request') {
        const body = JSON.parse(options.body || '{}');
        return Response.json({ withdrawalId: 'wd_1', player: walletAddress, amount: body.amount, payoutAmount: '950000', feeAmount: '50000', status: 'pending' });
      }
      return new Response('not found', { status: 404 });
    });
    window.ethereum = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return '0x14a34';
        if (method === 'eth_sendTransaction') return txHash;
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'wallet_addEthereumChain') return null;
        return null;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  it('renders explanatory landing without board or contract noise', async () => {
    render(<App />);
    expect(await screen.findByText(/Tap tiles\./i)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /find the prizes before your third bomb/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Chancy 8x8 board/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Contract 0x/i)).not.toBeInTheDocument();
  });

  it('rules modal locks body scroll while open and restores on close', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    expect(document.body.style.overflow).toBe('hidden');
    closeRules();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('connects an injected wallet and switches to the target Base chain', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));
    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_requestAccounts' })));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /0x9999…9999/i }).length).toBeGreaterThan(0));
  });

  it('deposits credits by sending only a txHash to the server', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    fireEvent.change(await screen.findByLabelText(/add credits \(usdc\)/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /^add credits$/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/v2/tx/approve-usdc', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/v2/tx/deposit', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => {
      const call = global.fetch.mock.calls.find(([u]) => u === '/v2/credits/deposit');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ player: walletAddress, txHash });
    });
  });

  it('starts a server-side round and reveals tiles with NO wallet transaction', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /play normal — \$0\.05/i }));

    expect(await screen.findByLabelText(/Chancy 8x8 board/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^tile \d+$/i })).toHaveLength(64);

    window.ethereum.request.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/v2/sessions/1/click', expect.objectContaining({ method: 'POST' })));
    // The whole point: clicking a tile must NOT trigger any wallet transaction.
    expect(window.ethereum.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
    // Tile click sends a 1-indexed tile number.
    const clickCall = global.fetch.mock.calls.find(([u]) => u === '/v2/sessions/1/click');
    expect(JSON.parse(clickCall[1].body).tile).toBe(7);
  });

  it('creates a session with $0.05 stake in 6-decimal units, no per-join tx', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /play normal — \$0\.05/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/v2/sessions', expect.objectContaining({ method: 'POST' })));
    const call = global.fetch.mock.calls.find(([u]) => u === '/v2/sessions');
    const body = JSON.parse(call[1].body);
    expect(body.stake).toBe('50000');
    expect(body.mode).toBe('Normal');
    expect(body.player).toBe(walletAddress);
    expect(body.entropy).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('requests a withdrawal of credits to the wallet', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    fireEvent.click(screen.getByRole('button', { name: /^play$/i }));

    // wallet auto-connects via the deposit/connect path; connect explicitly first
    fireEvent.click(screen.getAllByRole('button', { name: /connect wallet/i })[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /0x9999…9999/i }).length).toBeGreaterThan(0));

    fireEvent.change(await screen.findByLabelText(/cash out \(usdc\)/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /^cash out$/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/v2/withdrawals/request', expect.objectContaining({ method: 'POST' })));
    const call = global.fetch.mock.calls.find(([u]) => u === '/v2/withdrawals/request');
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ player: walletAddress, amount: '1000000', destination: walletAddress });
  });
});
