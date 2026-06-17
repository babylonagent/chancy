import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App.jsx';

const txPayload = { to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0' };
const walletAddress = '0x9999999999999999999999999999999999999999';

function closeRules() {
  fireEvent.click(screen.getByRole('button', { name: /got it/i }));
}

async function openRoleChoice() {
  fireEvent.click(screen.getAllByRole('button', { name: /^play$/i }).at(-1));
  return screen.findByText('Play a room or host one.');
}

describe('Chancy web client', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/health') return Response.json({ ok: true, service: 'chancy-api', contractAddress: txPayload.to });
      if (url.startsWith('/data/sessions')) {
        return Response.json({ source: 'contract', nextSessionId: '3', sessions: [
          { sessionId: '2', host: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', difficulty: 'Normal', prizePot: '25000000', activePlayer: '0x0000000000000000000000000000000000000000', bombCount: 7, prizeCount: 2, open: true },
        ] });
      }
      if (url.startsWith('/data/entropy-fee')) return Response.json({ fee: '123', provider: '0x4444444444444444444444444444444444444444', entropyAddress: '0x5555555555555555555555555555555555555555' });
      if (url.startsWith('/tx/')) return Response.json({ ...txPayload, route: url, body: JSON.parse(options.body || '{}') });
      if (url.startsWith('/read/')) return Response.json({ ...txPayload, decodeAs: 'sessions' });
      return new Response('not found', { status: 404 });
    });
    window.ethereum = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_sendTransaction') return '0x' + 'aa'.repeat(32);
        return null;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  it('renders explanatory landing without board or contract noise', async () => {
    render(<App />);

    expect(await screen.findByText('One game. Two paths: play or host.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /find prizes before your third bomb/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Chancy 8x8 board/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Contract 0x/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Easy has 5 bombs/i)).toBeInTheDocument();
  });

  it('dismisses and reopens the explanatory rules modal with difficulty copy', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);

    closeRules();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /how chancy works/i }));
    expect(screen.getByRole('dialog', { name: /find prizes before your third bomb/i })).toBeInTheDocument();
    expect(screen.getByText(/Normal has 7 bombs and 2 prizes/i)).toBeInTheDocument();
  });

  it('routes through player choice before showing live rooms', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();

    await openRoleChoice();
    fireEvent.click(screen.getByRole('button', { name: /continue as player/i }));

    expect(await screen.findByText('Choose an open room.')).toBeInTheDocument();
    expect(await screen.findByText('Room #2')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Chancy 8x8 board/i)).not.toBeInTheDocument();
  });

  it('joining a listed session opens the player board', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    await openRoleChoice();
    fireEvent.click(screen.getByRole('button', { name: /continue as player/i }));

    fireEvent.click(await screen.findByRole('button', { name: /join room/i }));

    expect(await screen.findByText('Your board')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /tile/i })).toHaveLength(64);
    expect(screen.getByText(/Bombs hidden/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/tx/click-tile', expect.objectContaining({ method: 'POST' })));
  });

  it('host flow creates a room without asking for room id', async () => {
    render(<App />);
    await screen.findByText(/Chancy live/i);
    closeRules();
    await openRoleChoice();

    fireEvent.click(screen.getByRole('button', { name: /continue as host/i }));
    expect(screen.getByText('Create a prize room.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/session id/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^create room$/i }));

    expect(await screen.findByText('Host view')).toBeInTheDocument();
    expect(screen.queryByText(/contract assigns/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Chancy 8x8 board/i)).toBeInTheDocument();
  });

  it('connects an injected wallet from wallet management copy', async () => {
    render(<App />);
    closeRules();
    await openRoleChoice();

    expect(screen.getByText(/Connect wallet to manage your rooms/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /connect wallet/i })[0]);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /0x9999…9999/i }).length).toBeGreaterThan(0));
    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_requestAccounts' })));
  });
});
