/**
 * Admin bundle management routes.
 * Replaces supabase.from('engagement_bundles'/'bundle_items'/'service_provider_mapping')
 * and supabase.functions.invoke('import-services').
 */

import express from 'express';
import { query, withTx } from '../db.js';
import { ah, requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAdmin);

// ─── GET /api/admin/bundles ────────────────────────────────────────────────
router.get('/', ah(async (_req, res) => {
  const { rows: bundles } = await query(
    `SELECT * FROM engagement_bundles ORDER BY sort_order, created_at`
  );
  const { rows: items } = await query(
    `SELECT bi.*,
            s.id AS svc_id, s.name AS svc_name, s.price AS svc_price,
            s.min_quantity AS svc_min, s.provider_id AS svc_provider_id,
            s.provider_service_id AS svc_provider_service_id
       FROM bundle_items bi
       LEFT JOIN services s ON s.id = bi.service_id
      ORDER BY bi.sort_order, bi.created_at`
  );

  // Nest items into bundles
  const itemsByBundle = {};
  for (const item of items) {
    if (!itemsByBundle[item.bundle_id]) itemsByBundle[item.bundle_id] = [];
    const { svc_id, svc_name, svc_price, svc_min, svc_provider_id, svc_provider_service_id, ...rest } = item;
    itemsByBundle[item.bundle_id].push({
      ...rest,
      service: svc_id ? {
        id: svc_id,
        name: svc_name,
        price: svc_price,
        min_quantity: svc_min,
        provider_id: svc_provider_id,
        provider_service_id: svc_provider_service_id,
      } : null,
    });
  }

  res.json(bundles.map(b => ({ ...b, items: itemsByBundle[b.id] || [] })));
}));

// ─── POST /api/admin/bundles ───────────────────────────────────────────────
router.post('/', ah(async (req, res) => {
  const { name, platform, description } = req.body;
  if (!name || !platform) return res.status(400).json({ error: 'name and platform required' });
  const { rows } = await query(
    `INSERT INTO engagement_bundles (name, platform, description, is_active)
     VALUES ($1,$2,$3,true) RETURNING *`,
    [name, platform, description || null]
  );
  res.json(rows[0]);
}));

// ─── PATCH /api/admin/bundles/:id ─────────────────────────────────────────
router.patch('/:id', ah(async (req, res) => {
  const { id } = req.params;
  const allowed = ['is_active', 'ai_organic_enabled', 'use_custom_ratios', 'name', 'description', 'sort_order'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = $${vals.length + 2}`);
      vals.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await query(
    `UPDATE engagement_bundles SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, ...vals]
  );
  res.json(rows[0] || {});
}));

// ─── DELETE /api/admin/bundles/:id ────────────────────────────────────────
router.delete('/:id', ah(async (req, res) => {
  await query(`DELETE FROM engagement_bundles WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ─── POST /api/admin/bundles/:id/items ────────────────────────────────────
router.post('/:id/items', ah(async (req, res) => {
  const { engagement_type, service_id, ratio_percent, is_base } = req.body;
  if (!engagement_type) return res.status(400).json({ error: 'engagement_type required' });
  const { rows } = await query(
    `INSERT INTO bundle_items (bundle_id, engagement_type, service_id, ratio_percent, is_base)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, engagement_type, service_id || null, ratio_percent ?? 100, is_base ?? false]
  );
  res.json(rows[0]);
}));

// ─── PATCH /api/admin/bundle-items/:id ────────────────────────────────────
router.patch('/items/:id', ah(async (req, res) => {
  const allowed = ['service_id', 'ratio_percent', 'price_per_k', 'sort_order', 'is_base',
                   'default_drip_qty_per_run', 'default_drip_interval', 'default_drip_interval_unit'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (key in req.body) {
      sets.push(`${key} = $${vals.length + 2}`);
      vals.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await query(
    `UPDATE bundle_items SET ${sets.join(', ')} WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  );
  res.json(rows[0] || {});
}));

// ─── DELETE /api/admin/bundle-items/:id ───────────────────────────────────
router.delete('/items/:id', ah(async (req, res) => {
  await query(`DELETE FROM bundle_items WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ─── GET /api/admin/services ──────────────────────────────────────────────
router.get('/services', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, price, min_quantity, provider_id, provider_service_id, category, is_active
       FROM services WHERE is_active=true ORDER BY category, name`
  );
  res.json(rows);
}));

// ─── GET /api/admin/service-provider-mappings?service_id=xxx ─────────────
router.get('/service-provider-mappings', ah(async (req, res) => {
  const { service_id } = req.query;
  const { rows } = service_id
    ? await query(`SELECT * FROM service_provider_mapping WHERE service_id=$1 ORDER BY sort_order`, [service_id])
    : await query(`SELECT DISTINCT service_id FROM service_provider_mapping WHERE service_id IS NOT NULL`);
  res.json(rows);
}));

// ─── POST /api/admin/service-provider-mappings ────────────────────────────
// Body: { service_id, bundle_item_id, mappings: [{provider_account_id, provider_service_id, sort_order, checked}] }
router.post('/service-provider-mappings', ah(async (req, res) => {
  const { service_id, mappings } = req.body;
  if (!service_id || !Array.isArray(mappings)) {
    return res.status(400).json({ error: 'service_id and mappings[] required' });
  }

  await withTx(async (client) => {
    const { rows: current } = await client.query(
      `SELECT id, provider_account_id FROM service_provider_mapping WHERE service_id=$1`,
      [service_id]
    );
    const currentMap = Object.fromEntries(current.map(r => [r.provider_account_id, r.id]));

    const checked = mappings.filter(m => m.checked);
    const checkedIds = new Set(checked.map(m => m.provider_account_id));

    // Delete unchecked
    const toDelete = current.filter(r => !checkedIds.has(r.provider_account_id)).map(r => r.id);
    if (toDelete.length > 0) {
      await client.query(`DELETE FROM service_provider_mapping WHERE id = ANY($1)`, [toDelete]);
    }

    // Upsert checked
    for (const m of checked) {
      if (currentMap[m.provider_account_id]) {
        await client.query(
          `UPDATE service_provider_mapping SET provider_service_id=$1, sort_order=$2, is_active=true WHERE id=$3`,
          [m.provider_service_id, m.sort_order ?? 0, currentMap[m.provider_account_id]]
        );
      } else {
        await client.query(
          `INSERT INTO service_provider_mapping (service_id, provider_account_id, provider_service_id, sort_order, is_active)
           VALUES ($1,$2,$3,$4,true)`,
          [service_id, m.provider_account_id, m.provider_service_id, m.sort_order ?? 0]
        );
      }
    }
  });

  const { rows } = await query(`SELECT * FROM service_provider_mapping WHERE service_id=$1 ORDER BY sort_order`, [service_id]);
  res.json({ ok: true, mappings: rows });
}));

// ─── POST /api/admin/bundles/import-services ─────────────────────────────
// Body:
//   { provider_id, action:'fetch',  search_query?, markup_percent? }
//   { provider_id, action:'import', service_ids:[], markup_percent?, category_override? }
// Fetches service list from the SMM provider API. 'fetch' returns the catalog
// for the UI; 'import' upserts the selected services into the services table.
// Never returns provider API keys.
router.post('/import-services', ah(async (req, res) => {
  const {
    provider_id,
    action = 'import',
    service_ids = [],
    markup_percent = 0,
    category_override,
    search_query = '',
  } = req.body || {};
  if (!provider_id) return res.status(400).json({ error: 'provider_id required' });

  // Get an active provider account for this provider (least recently used).
  const { rows: accounts } = await query(
    `SELECT api_url, api_key FROM provider_accounts
      WHERE provider_id = $1 AND is_active = true
        AND NULLIF(TRIM(api_key), '') IS NOT NULL
        AND NULLIF(TRIM(api_url), '') IS NOT NULL
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1`,
    [provider_id]
  );
  if (!accounts.length) return res.status(404).json({ error: `No active account for provider ${provider_id}` });

  const { api_url, api_key } = accounts[0];

  // Fetch services list from provider.
  const body = new URLSearchParams({ key: api_key, action: 'services' });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let providerServices = [];
  try {
    const r = await fetch(api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const text = await r.text();
    providerServices = JSON.parse(text);
  } catch (e) {
    return res.status(502).json({ error: `Provider request failed: ${e.message}` });
  } finally {
    clearTimeout(t);
  }

  if (!Array.isArray(providerServices)) {
    return res.status(502).json({ error: 'Provider returned unexpected format' });
  }

  // ── action: 'fetch' — return the (optionally searched) catalog ──────────
  if (action === 'fetch') {
    const q = String(search_query || '').trim().toLowerCase();
    const normalized = providerServices.map((s) => ({
      service_id: String(s.service ?? s.id ?? ''),
      name: s.name || `Service ${s.service ?? s.id ?? ''}`,
      category: s.category || 'General',
      rate: Number(parseFloat(s.rate ?? s.price ?? 0)) || 0,
      min: parseInt(s.min ?? s.min_quantity ?? 0, 10) || 0,
      max: parseInt(s.max ?? s.max_quantity ?? 0, 10) || 0,
      dripfeed: s.dripfeed === true || String(s.dripfeed).toLowerCase() === 'true' || s.dripfeed === 1,
      refill: s.refill === true || String(s.refill).toLowerCase() === 'true' || s.refill === 1,
    }));
    const filtered = q
      ? normalized.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q) ||
            s.service_id.includes(q)
        )
      : normalized;
    return res.json({ services: filtered, total: normalized.length, filtered: filtered.length });
  }

  // ── action: 'import' — upsert selected services ─────────────────────────
  const ids = new Set(service_ids.map(String));
  const toImport = ids.size > 0
    ? providerServices.filter((s) => ids.has(String(s.service ?? s.id)))
    : providerServices;

  const markup = 1 + (Number(markup_percent) / 100);
  let imported = 0;
  let updated = 0;

  await withTx(async (client) => {
    for (const svc of toImport) {
      const svcId    = String(svc.service ?? svc.id);
      const rawPrice = parseFloat(svc.rate ?? svc.price ?? 0) / 1000; // provider rate is per 1000
      const price    = Math.round(rawPrice * markup * 1000000) / 1000000;
      const name     = svc.name || `Service ${svcId}`;
      const category = category_override || svc.category || 'General';
      const minQty   = parseInt(svc.min ?? svc.min_quantity ?? 10, 10) || 10;
      const maxQty   = parseInt(svc.max ?? svc.max_quantity ?? 100000, 10) || 100000;
      const dripfeed = svc.dripfeed === true || String(svc.dripfeed).toLowerCase() === 'true' || svc.dripfeed === 1;

      // Manual upsert — the services table has no unique (provider_id, provider_service_id) constraint.
      const existing = await client.query(
        `SELECT id FROM services WHERE provider_id = $1 AND provider_service_id = $2 LIMIT 1`,
        [provider_id, svcId]
      );
      if (existing.rows[0]) {
        await client.query(
          `UPDATE services
              SET name = $1, category = $2, price = $3,
                  min_quantity = $4, max_quantity = $5,
                  drip_feed_enabled = $6, is_active = true, updated_at = now()
            WHERE id = $7`,
          [name, category, price, minQty, maxQty, dripfeed, existing.rows[0].id]
        );
        updated += 1;
      } else {
        await client.query(
          `INSERT INTO services
             (provider_id, provider_service_id, name, category, price,
              min_quantity, max_quantity, drip_feed_enabled, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
          [provider_id, svcId, name, category, price, minQty, maxQty, dripfeed]
        );
        imported += 1;
      }
    }
  });

  res.json({ success: true, imported, updated, total: toImport.length });
}));

export default router;
