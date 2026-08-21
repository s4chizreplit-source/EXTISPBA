import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createOxaPayInvoice,
  makeOxaPayEventHash,
  normalizeOxaPayPayload,
  parseWalletTopupAmount,
  sanitizeOxaPayPayload,
  validateOxaPayPayment,
  verifyOxaPaySignature,
} from '../../server/src/services/oxapay.js';

describe('OxaPay wallet top-up security', () => {
  it('validates and converts INR using the server-owned rate', () => {
    expect(parseWalletTopupAmount(1000)).toEqual({ amountInr: 1000, amountUsd: 11.98 });
    expect(() => parseWalletTopupAmount(99)).toThrow('Minimum is INR 100');
    expect(() => parseWalletTopupAmount(500001)).toThrow('Maximum is INR 500000');
  });

  it('verifies HMAC SHA-512 over the exact raw body', () => {
    const key = 'merchant-test-key';
    const raw = Buffer.from('{"status":"paid","track_id":"123"}');
    const signature = createHmac('sha512', key).update(raw).digest('hex');

    expect(verifyOxaPaySignature(raw, signature, key)).toBe(true);
    expect(verifyOxaPaySignature(Buffer.from(`${raw} `), signature, key)).toBe(false);
    expect(verifyOxaPaySignature(raw, 'not-a-signature', key)).toBe(false);
  });

  it('normalizes wrapped provider responses without exposing sensitive fields', () => {
    const payload = {
      data: {
        status: 'Paid',
        track_id: 123,
        order_id: 'oxw_order',
        amount: 11.98,
        currency: 'usd',
        payment_url: 'https://example.test/private',
        email: 'private@example.test',
        address: 'private-wallet',
      },
    };

    expect(normalizeOxaPayPayload(payload)).toMatchObject({
      status: 'paid',
      trackId: '123',
      orderId: 'oxw_order',
      amount: 11.98,
      currency: 'USD',
      paidAmount: null,
    });
    expect(sanitizeOxaPayPayload(payload)).toEqual({
      status: 'paid',
      track_id: '123',
      order_id: 'oxw_order',
      amount: 11.98,
      currency: 'USD',
      paid_amount: null,
      paid_currency: null,
      expired_at: null,
    });
  });

  it('accepts a documented successful invoice response with an empty error placeholder', async () => {
    const originalKey = process.env.OXAPAY_MERCHANT_API_KEY;
    process.env.OXAPAY_MERCHANT_API_KEY = 'merchant-test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        track_id: 'track-success',
        payment_url: 'https://pay.oxapay.com/example',
      },
      message: 'Operation completed successfully!',
      error: { type: null, key: null, message: null },
      status: 200,
      version: '1.0.0',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { invoice } = await createOxaPayInvoice({ amount: 11.98 });
      expect(invoice.trackId).toBe('track-success');
      expect(invoice.paymentUrl).toBe('https://pay.oxapay.com/example');
    } finally {
      vi.unstubAllGlobals();
      if (originalKey === undefined) delete process.env.OXAPAY_MERCHANT_API_KEY;
      else process.env.OXAPAY_MERCHANT_API_KEY = originalKey;
    }
  });

  it('requires a paid provider response for the exact deposit', () => {
    const deposit = {
      track_id: 'track-1',
      order_id: 'oxw_order',
      amount_usd: '11.98',
    };
    const valid = {
      data: {
        status: 'paid',
        track_id: 'track-1',
        order_id: 'oxw_order',
        amount: 11.98,
        currency: 'USD',
      },
    };

    expect(validateOxaPayPayment(valid, deposit, 'track-1').paid).toBe(true);
    expect(validateOxaPayPayment({ data: { ...valid.data, status: 'paying' } }, deposit, 'track-1').paid).toBe(false);
    expect(() => validateOxaPayPayment({ data: { ...valid.data, order_id: 'other' } }, deposit, 'track-1')).toThrow('order ID');
    expect(() => validateOxaPayPayment({ data: { ...valid.data, amount: 5 } }, deposit, 'track-1')).toThrow('amount does not match');
    expect(() => validateOxaPayPayment({ data: { ...valid.data, paid_amount: 11.84 } }, deposit, 'track-1')).toThrow('underpaid');
    expect(() => validateOxaPayPayment({ data: { ...valid.data, currency: 'EUR' } }, deposit, 'track-1')).toThrow('currency');
    expect(validateOxaPayPayment({ data: { ...valid.data, paid_amount: 15 } }, deposit, 'track-1').paid).toBe(true);
  });

  it('hashes equivalent webhook objects deterministically', () => {
    const first = makeOxaPayEventHash('order', { status: 'paid', data: { b: 2, a: 1 } });
    const second = makeOxaPayEventHash('order', { data: { a: 1, b: 2 }, status: 'paid' });
    const changed = makeOxaPayEventHash('order', { data: { a: 1, b: 3 }, status: 'paid' });

    expect(first).toBe(second);
    expect(changed).not.toBe(first);
  });
});