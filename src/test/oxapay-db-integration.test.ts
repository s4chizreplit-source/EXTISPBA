import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  getPayment: vi.fn(),
}));

vi.mock('../../server/src/services/oxapay.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/src/services/oxapay.js')>();
  return {
    ...actual,
    createOxaPayInvoice: providerMocks.createInvoice,
    getOxaPayPayment: providerMocks.getPayment,
  };
});

const { default: oxapayRouter } = await import('../../server/src/routes/oxapay.js');
const { pool } = await import('../../server/src/db.js');
const { normalizeOxaPayPayload } = await import('../../server/src/services/oxapay.js');

const TEST_KEY = 'db-integration-merchant-key';
let originalMerchantKey: string | undefined;

function makeWebhookApp() {
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buffer) => {
      if (req.originalUrl?.startsWith('/api/oxapay/webhook')) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  }));
  app.use('/api/oxapay', oxapayRouter);
  return app;
}

async function sendWebhook(body: unknown) {
  const app = makeWebhookApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const raw = JSON.stringify(body);
  const hmac = createHmac('sha512', TEST_KEY).update(Buffer.from(raw)).digest('hex');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/oxapay/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        HMAC: hmac,
      },
      body: raw,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

beforeAll(() => {
  originalMerchantKey = process.env.OXAPAY_MERCHANT_API_KEY;
  process.env.OXAPAY_MERCHANT_API_KEY = TEST_KEY;
});

afterAll(async () => {
  if (originalMerchantKey === undefined) delete process.env.OXAPAY_MERCHANT_API_KEY;
  else process.env.OXAPAY_MERCHANT_API_KEY = originalMerchantKey;
  await pool.end();
});

describe('OxaPay PostgreSQL credit integration', () => {
  it('credits one wallet transaction for a signed paid webhook and ignores its replay', async () => {
    const userId = randomUUID();
    const orderId = `oxw_dbtest_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const trackId = `db-track-${randomUUID()}`;
    const body = {
      status: 'paid',
      track_id: trackId,
      order_id: orderId,
      amount: 10,
      currency: 'USD',
    };
    const providerPayload = {
      data: {
        ...body,
        paid_amount: 10,
        paid_currency: 'USD',
      },
    };

    try {
      await pool.query(
        `INSERT INTO auth_users (id,email,created_at) VALUES ($1,$2,now())`,
        [userId, `oxapay-dbtest-${userId}@example.invalid`],
      );
      await pool.query(
        `INSERT INTO oxapay_deposits
          (user_id,purpose,track_id,order_id,amount_usd,amount_inr,status)
         VALUES ($1,'wallet',$2,$3,10,835,'pending')`,
        [userId, trackId, orderId],
      );
      providerMocks.getPayment.mockResolvedValue({
        payload: providerPayload,
        payment: normalizeOxaPayPayload(providerPayload),
      });

      expect(await sendWebhook(body)).toEqual({ status: 200, text: 'ok' });
      expect(await sendWebhook(body)).toEqual({ status: 200, text: 'ok' });

      const { rows: [state] } = await pool.query(
        `SELECT
          (SELECT credited FROM oxapay_deposits WHERE order_id=$1) AS credited,
          (SELECT balance FROM wallets WHERE user_id=$2) AS balance,
          (SELECT total_deposited FROM wallets WHERE user_id=$2) AS total_deposited,
          (SELECT count(*)::int FROM transactions
            WHERE user_id=$2 AND payment_method='oxapay' AND payment_reference=$1) AS transaction_count`,
        [orderId, userId],
      );
      expect(state).toMatchObject({
        credited: true,
        balance: '10.0000',
        total_deposited: '10.0000',
        transaction_count: 1,
      });
      expect(providerMocks.getPayment).toHaveBeenCalledTimes(1);
    } finally {
      await pool.query(`DELETE FROM transactions WHERE user_id=$1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM webhook_events WHERE order_id=$1`, [orderId]).catch(() => {});
      await pool.query(`DELETE FROM oxapay_activity_log WHERE order_id=$1`, [orderId]).catch(() => {});
      await pool.query(`DELETE FROM oxapay_deposits WHERE order_id=$1`, [orderId]).catch(() => {});
      await pool.query(`DELETE FROM wallets WHERE user_id=$1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM auth_users WHERE id=$1`, [userId]).catch(() => {});
    }
  }, 30000);
});