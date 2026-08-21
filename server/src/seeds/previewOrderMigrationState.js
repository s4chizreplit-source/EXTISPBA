export function preparePreviewItemsForMigration(items) {
  return items.map(item => ({
    ...item,
    status: item.status === 'completed' ? 'completed' : 'processing',
    error_message: null,
  }));
}

export function preparePreviewRunsForMigration(runs) {
  const activeProviderStatuses = new Set([
    'active',
    'in progress',
    'inprogress',
    'partial',
    'pending',
    'processing',
  ]);

  return runs.map(run => {
    if (run.status === 'completed') return run;

    const providerStatus = String(run.provider_status || '').trim().toLowerCase();
    const hasActiveProviderOrder =
      Boolean(run.provider_order_id) && activeProviderStatuses.has(providerStatus);

    if (hasActiveProviderOrder) {
      return {
        ...run,
        status: 'processing',
        error_message: null,
        completed_at: null,
      };
    }

    return {
      ...run,
      status: 'pending',
      provider_order_id: null,
      provider_response: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      provider_start_count: null,
      provider_remains: null,
      provider_status: null,
      provider_charge: null,
      last_status_check: null,
      retry_count: 0,
      provider_account_id: null,
      provider_account_name: null,
      rotation_lock_key: null,
    };
  });
}