import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';

const {
  getProviderOrderQuantity,
  isProviderMinimumQuantityError,
} = await import('../src/provider.js');
const {
  getDispatchFallback,
  getProviderQuantityDecision,
} = await import('../src/cron.js');
const {
  findBundleItemForEngagement,
  getEffectiveProviderMinimum,
  uniquifyScheduledRuns,
} = await import('../src/routes/create-engagement-order.js');

test('scheduled quantities are redistributed above the configured provider minimum', () => {
  const schedule = uniquifyScheduledRuns(
    [
      { scheduled_at: '2026-01-01T00:00:00.000Z', quantity_to_send: 30 },
      { scheduled_at: '2026-01-01T01:00:00.000Z', quantity_to_send: 30 },
      { scheduled_at: '2026-01-01T02:00:00.000Z', quantity_to_send: 30 },
      { scheduled_at: '2026-01-01T03:00:00.000Z', quantity_to_send: 10 },
      { scheduled_at: '2026-01-01T04:00:00.000Z', quantity_to_send: 5 },
    ],
    105,
    10,
    50
  );

  assert.equal(schedule.reduce((total, run) => total + run.quantity_to_send, 0), 105);
  assert.ok(schedule.every(run => run.quantity_to_send >= 10));
});

test('an impossible scheduled total does not create a below-minimum run', () => {
  const schedule = uniquifyScheduledRuns(
    [{ scheduled_at: '2026-01-01T00:00:00.000Z', quantity_to_send: 5 }],
    5,
    10,
    50
  );

  assert.deepEqual(schedule, []);
});

test('dispatch skips multiplier-adjusted quantities below the provider minimum', () => {
  assert.equal(getProviderOrderQuantity(10, 2), 5);
  assert.deepEqual(
    getProviderQuantityDecision({
      quantityToSend: 10,
      deliveryMultiplier: 2,
      providerMinimum: 10,
    }),
    { sendQty: 5, minimum: 10, meetsMinimum: false }
  );
});

test('provider minimum API errors are classified as non-retryable', () => {
  assert.equal(isProviderMinimumQuantityError('Minimum quantity is 100'), true);
  assert.equal(isProviderMinimumQuantityError('Quantity is below the minimum order limit'), true);
  assert.equal(isProviderMinimumQuantityError('Minimum: 100'), true);
  assert.equal(isProviderMinimumQuantityError('Min 100'), true);
  assert.equal(isProviderMinimumQuantityError('provider timed out'), false);
});

test('busy and transient providers take precedence over minimum-only handling', () => {
  assert.equal(
    getDispatchFallback({ minimumProblemCount: 1, busyProviderCount: 1, lastError: null }),
    'wait'
  );
  assert.equal(
    getDispatchFallback({
      minimumProblemCount: 1,
      busyProviderCount: 0,
      lastError: new Error('provider timed out'),
    }),
    'retry'
  );
  assert.equal(
    getDispatchFallback({ minimumProblemCount: 2, busyProviderCount: 0, lastError: null }),
    'minimum'
  );
});

test('same-type bundle items use the explicitly selected service minimum', () => {
  const bundleItems = [
    { service_id: 'service-small', engagement_type: 'likes', min_quantity: 10 },
    { service_id: 'service-large', engagement_type: 'likes', min_quantity: 75 },
  ];
  const selected = findBundleItemForEngagement(bundleItems, {
    type: 'likes',
    service_id: 'service-large',
  });

  assert.equal(selected.service_id, 'service-large');
  assert.equal(getEffectiveProviderMinimum('likes', selected.min_quantity, 2), 150);
});