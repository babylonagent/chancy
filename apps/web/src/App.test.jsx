import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App.jsx';

const txPayload = { to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0' };

describe('Chancy web client', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/health') {
        return Response.json({ ok: true, service: 'chancy-api' });
      }
      if (url.startsWith('/tx/')) {
        return Response.json({ ...txPayload, route: url, body: JSON.parse(options.body || '{}') });
      }
      if (url.startsWith('/read/')) {
        return Response.json({ ...txPayload, decodeAs: 'sessions' });
      }
      return new Response('not found', { status: 404 });
    });
  });

  it('renders 64 board tiles and controls', async () => {
    render(<App />);

    expect(await screen.findByText('Chancy')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /tile/i })).toHaveLength(64);
    expect(screen.getByLabelText(/difficulty/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /build create session tx/i })).toBeInTheDocument();
  });

  it('builds create-session and click-tile transaction payloads from the API', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /build create session tx/i }));
    expect(await screen.findByText(/\/tx\/create-session/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'tile 7' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/tx/click-tile', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/\/tx\/click-tile/)).toBeInTheDocument();
  });

  it('builds join and read payloads', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /build join tx/i }));
    expect(await screen.findByText(/\/tx\/join-session/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /build session read/i }));
    expect(await screen.findByText(/sessions/)).toBeInTheDocument();
  });
});
