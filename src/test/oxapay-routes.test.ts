import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTx: vi.fn(),
  createInvoice: vi.fn(),
  getPayment: vi.fn(),
}));

vi.mock('../../server/src/db.js', () => ({
  query: mocks.query,
  withTx: mocks.withTx,
}));

vi.mock('../../server/src/services/oxapay.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/src/services/oxapay.js')>();
  return {
    ...actual,
    createOxaPayInvoice: mocks.createInvoice,
    getOxaPayPayment: mocks.getPayment,
  };
});

const {
  default: oxapayRouter,
  creditWalletDeposit,
} = await import('../../server/src/routes/oxapay.js');
const {
  OxaPayProviderError,
  normalizeOxaPayPayload,
} = await import('../../server/src/services/oxapay.js');

const TEST_USER = '11111111-1111-4111-8111-111111111111';
const TEST_ORDER = 'oxw_11111111_1234567890_abcdef12';
const TEST_KEY = 'test-merchant-key';
let originalMerchantKey: string | undefined;
let originalPublicAppUrl: string | undefined;

function makeApp() {
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buffer) => {
      if (req.originalUrl?.startsWith('/api/oxapay/webhook')) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  }));
  app.use((req: any, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { userId } : {};
    next();
  });
  app.use('/api/oxapay', oxapayRouter);
  return app;
}

async function post(path: string, body: unknown, options: { userId?: string; hmac?: string } = {}) {
  const app = makeApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const raw = JSON.stringify(body);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.userId ? { 'x-test-user': options.userId } : {}),
        ...(options.hmac ? { HMAC: options.hmac } : {}),
      },
      body: raw,
    });
    return {
      status: response.status,
      text: await response.text(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function signed(body: unknown) {
  return createHmac('sha512', TEST_KEY)
    .update(Buffer.from(JSON.stringify(body)))
    .digest('hex');
}

function deposit(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: TEST_USER,
    purpose: 'wallet',
    order_id: TEST_ORDER,
    track_id: 'track-1',
    amount_usd: '10.00',
    status: 'pending',
    credited: false,
    ...overrides,
  };
}

beforeAll(() => {
  originalMerchantKey = process.env.OXAPAY_MERCHANT_API_KEY;
  originalPublicAppUrl = process.env.PUBLIC_APP_URL;
  process.env.OXAPAY_MERCHANT_API_KEY = TEST_KEY;
  process.env.PUBLIC_APP_URL = 'https://extipspanel.com';
});

afterAll(() => {
  if (originalMerchantKey === undefined) delete process.env.OXAPAY_MERCHANT_API_KEY;
  else process.env.OXAPAY_MERCHANT_API_KEY = originalMerchantKey;
  if (originalPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicAppUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_APP_URL = 'https://extipspanel.com';
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('OxaPay routes', () => {
  it('requires authentication before creating an invoice', async () => {
    const response = await post('/api/oxapay/create-wallet-topup', { amount_inr: 100 });
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects out-of-range amounts before database or provider calls', async () => {
    const response = await post(
      '/api/oxapay/create-wallet-topup',
      { amount_inr: 99 },
      { userId: TEST_USER },
    );
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it('uses the explicitly configured production URL for callback and return links', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ email: 'test@example.invalid' }] })
      .mockResolvedValue({ rows: [] });
    mocks.createInvoice.mockResolvedValueOnce({
      payload: {
        data: {
          track_id: 'track-created',
          payment_url: 'https://pay.example.invalid/invoice',
        },
      },
      invoice: {
        trackId: 'track-created',
        paymentUrl: 'https://pay.example.invalid/invoice',
        status: 'new',
      },
    });

    const response = await post(
      '/api/oxapay/create-wallet-topup',
      { amount_inr: 100 },
      { userId: TEST_USER },
    );
    expect(response.status).toBe(200);
    const invoiceRequest = mocks.createInvoice.mock.calls[0][0];
    expect(invoiceRequest.callback_url).toBe('https://extipspanel.com/api/oxapay/webhook');
    expect(invoiceRequest.return_url).toMatch(
      /^https:\/\/extipspanel\.com\/wallet\?deposit=success&order_id=oxw_/,
    );
  });

  it('fails closed when the canonical public URL is not configured', async () => {
    delete process.env.PUBLIC_APP_URL;
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ email: 'test@example.invalid' }] })
      .mockResolvedValue({ rows: [] });

    const response = await post(
      '/api/oxapay/create-wallet-topup',
      { amount_inr: 100 },
      { userId: TEST_USER },
    );
    expect(response.status).toBe(503);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it('scopes sync lookups to the authenticated owner', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await post(
      '/api/oxapay/sync-deposit',
      { order_id: TEST_ORDER },
      { userId: TEST_USER },
    );
    expect(response.status).toBe(404);
    expect(mocks.query.mock.calls[0][1]).toEqual([TEST_ORDER, TEST_USER]);
  });

  it('rejects a forged webhook before deposit lookup or credit', async () => {
    const body = {
      status: 'paid',
      track_id: 'track-1',
      order_id: TEST_ORDER,
      amount: 10,
      currency: 'USD',
    };
    const response = await post('/api/oxapay/webhook', body, { hmac: 'bad' });
    expect(response.status).toBe(401);
    expect(mocks.getPayment).not.toHaveBeenCalled();
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it('acknowledges a finalized replay without re-querying the provider', async () => {
    const body = {
      status: 'paid',
      track_id: 'track-1',
      order_id: TEST_ORDER,
      amount: 10,
      currency: 'USD',
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [deposit({ credited: true, status: 'credited' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'event-1', outcome: 'wallet_credited', http_status: 200 }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await post('/api/oxapay/webhook', body, { hmac: signed(body) });
    expect(response).toEqual({ status: 200, text: 'ok' });
    expect(mocks.getPayment).not.toHaveBeenCalled();
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it('never credits an explicitly underpaid provider response', async () => {
    const body = {
      status: 'paid',
      track_id: 'track-1',
      order_id: TEST_ORDER,
      amount: 10,
      currency: 'USD',
    };
    const providerPayload = {
      data: {
        ...body,
        paid_amount: 9.8,
      },
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [deposit()] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValue({ rows: [] });
    mocks.getPayment.mockResolvedValueOnce({
      payload: providerPayload,
      payment: normalizeOxaPayPayload(providerPayload),
    });

    const response = await post('/api/oxapay/webhook', body, { hmac: signed(body) });
    expect(response).toEqual({ status: 200, text: 'ok' });
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it('returns a safe retryable response when provider verification is unavailable', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [deposit()] })
      .mockResolvedValue({ rows: [] });
    mocks.getPayment.mockRejectedValueOnce(
      new OxaPayProviderError('OxaPay is temporarily unavailable', 502),
    );

    const response = await post(
      '/api/oxapay/sync-deposit',
      { order_id: TEST_ORDER },
      { userId: TEST_USER },
    );
    expect(response.status).toBe(502);
    expect(response.text).not.toContain(TEST_KEY);
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it('short-circuits duplicate wallet credit before a second ledger insert', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [deposit({ credited: true, status: 'credited' })] })
        .mockResolvedValueOnce({ rows: [{ balance: '10.0000' }] }),
    };
    mocks.withTx.mockImplementationOnce(async callback => callback(client));

    const result = await creditWalletDeposit(TEST_ORDER, 'track-1');
    expect(result).toMatchObject({ credited: false, duplicate: true, newBalance: 10 });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO transactions'))).toBe(false);
  });
});