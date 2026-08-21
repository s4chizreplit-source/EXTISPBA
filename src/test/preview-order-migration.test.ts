import { describe, expect, it } from 'vitest';
import {
  preparePreviewItemsForMigration,
  preparePreviewRunsForMigration,
} from '../../server/src/seeds/previewOrderMigrationState.js';

describe('preview order migration state', () => {
  it('resumes unfinished items without reopening completed items', () => {
    const items = preparePreviewItemsForMigration([
      { id: 'cancelled', status: 'cancelled', error_message: 'Order cancelled' },
      { id: 'completed', status: 'completed', error_message: null },
    ]);

    expect(items).toEqual([
      { id: 'cancelled', status: 'processing', error_message: null },
      { id: 'completed', status: 'completed', error_message: null },
    ]);
  });

  it('polls active provider orders instead of dispatching duplicates', () => {
    const [run] = preparePreviewRunsForMigration([
      {
        id: 'active',
        status: 'cancelled',
        provider_order_id: '12345',
        provider_status: 'partial',
        error_message: 'Order cancelled',
        completed_at: '2026-08-21T00:00:00.000Z',
      },
    ]);

    expect(run).toMatchObject({
      status: 'processing',
      provider_order_id: '12345',
      provider_status: 'partial',
      error_message: null,
      completed_at: null,
    });
  });

  it('requeues cancelled provider orders and clears stale routing state', () => {
    const [run] = preparePreviewRunsForMigration([
      {
        id: 'cancelled',
        status: 'failed',
        provider_order_id: '67890',
        provider_status: 'canceled',
        provider_response: { status: 'canceled' },
        error_message: 'Provider cancelled',
        started_at: '2026-08-21T00:00:00.000Z',
        completed_at: '2026-08-21T00:01:00.000Z',
        retry_count: 3,
        provider_account_id: 'account',
        provider_account_name: 'Provider',
      },
    ]);

    expect(run).toMatchObject({
      status: 'pending',
      provider_order_id: null,
      provider_status: null,
      provider_response: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      provider_account_id: null,
      provider_account_name: null,
    });
  });

  it('leaves completed runs complete', () => {
    const run = {
      id: 'completed',
      status: 'completed',
      provider_order_id: 'done',
      completed_at: '2026-08-21T00:01:00.000Z',
    };

    expect(preparePreviewRunsForMigration([run])).toEqual([run]);
  });
});