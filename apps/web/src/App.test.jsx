import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
        return null;
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  it('renders landing content without a board or contract noise', async () => {
    render(<App />);

    expect(await screen.findByText('Pick a room. Reveal tiles. Dodge the third bomb.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /find prizes before your third bomb/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Chancy 8x8 board/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Contract 0x/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Browse open rooms by difficulty/i)).toBeInTheDocument();
  });

  it('dismisses and reopens the explanatory rules modal', async () => {
    render(<App />);
    await screen.findByText(/Game API online/i);

    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /how chancy works/i }));
    expect(screen.getByRole('dialog', { name: /find prizes before your third bomb/i })).toBeInTheDocument();
  });

  it('shows sessions list before any board is visible', async () => {
    render(<App />);
    await screen.findByText(/Game API online/i);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    fireEvent.click(screen.getByRole('button', { name: /browse sessions/i }));

    expect(screen.getByText('Choose where to play.')).toBeInTheDocument();
    expect(screen.getByText('Room #1')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Chancy 8x8 board/i)).not.toBeInTheDocument();
  });

  it('joining a listed session opens the player board', async () => {
    render(<App />);
    await screen.findByText(/Game API online/i);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse sessions/i }));

    const room = screen.getByText('Room #1').closest('article');
    fireEvent.click(within(room).getByRole('button', { name: /join room/i }));

    expect(await screen.findByText('Your board')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /tile/i })).toHaveLength(64);
    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/tx/click-tile', expect.objectContaining({ method: 'POST' })));
  });

  it('creating a room opens host view with a locked board', async () => {
    render(<App />);
    await screen.findByText(/Game API online/i);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse sessions/i }));

    fireEvent.click(screen.getByRole('button', { name: /^create room$/i }));

    expect(await screen.findByText('Host view')).toBeInTheDocument();
    expect(screen.getByText(/hosts cannot play their own room/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Chancy 8x8 board/i)).toBeInTheDocument();
  });

  it('connects an injected wallet', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    expect(await screen.findByRole('button', { name: /0x9999…9999/i })).toBeInTheDocument();
    await waitFor(() => expect(window.ethereum.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_requestAccounts' })));
  });
});
