/**
 * Stub / secondary-feature routes — these replace Supabase edge-function calls.
 * Features without a full backend implementation return 501 with a clear message.
 */
import { Router } from 'express';
import { requireAuth, ah } from '../middleware/auth.js';
import { query } from '../db.js';

const router = Router();

// ── Platform / maintenance ────────────────────────────────────────────────────
router.get('/platform/maintenance', ah(async (_req, res) => {
  try {
    const { rows } = await query(`SELECT maintenance_mode FROM platform_settings LIMIT 1`);
    res.json({ maintenanceMode: rows[0]?.maintenance_mode ?? false });
  } catch {
    res.json({ maintenanceMode: false });
  }
}));

// ── Instagram account features ────────────────────────────────────────────────
router.get('/instagram/accounts', requireAuth, ah(async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM instagram_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
}));

router.delete('/instagram/accounts/:id', requireAuth, ah(async (req, res) => {
  try {
    await query(
      `DELETE FROM instagram_accounts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove account' });
  }
}));

router.get('/instagram/link-events', requireAuth, ah(async (req, res) => {
  try {
    const since = req.query.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await query(
      `SELECT username, created_at FROM instagram_link_events
       WHERE user_id = $1 AND event_type = 'link' AND created_at >= $2
       ORDER BY created_at ASC`,
      [req.session.userId, since]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
}));

router.post('/instagram/link-account', requireAuth, (_req, res) => {
  res.status(501).json({ error: 'Instagram account linking is not available in this version.' });
});

router.post('/instagram/refresh-media', requireAuth, (_req, res) => {
  res.status(501).json({ error: 'Instagram media refresh is not available in this version.' });
});

// ── Live chat ─────────────────────────────────────────────────────────────────
router.get('/chat/messages', requireAuth, ah(async (req, res) => {
  const { conversation_id } = req.query;
  if (!conversation_id) return res.json([]);
  try {
    const { rows } = await query(
      `SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversation_id]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
}));

router.post('/chat/messages', requireAuth, ah(async (req, res) => {
  const { conversation_id, message } = req.body || {};
  if (!conversation_id || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows } = await query(
      `INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message)
       VALUES ($1, $2, 'user', $3) RETURNING *`,
      [conversation_id, req.session.userId, message.trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to send message' });
  }
}));

// ── Mass-order batch tracking (stub — tables may not exist) ───────────────────
router.patch('/mass-orders/batch-items/:id', requireAuth, ah(async (req, res) => {
  try {
    const { status, engagement_order_id, engagement_order_number, error_message } = req.body || {};
    await query(
      `UPDATE mass_order_batch_items
       SET status = COALESCE($1, status),
           engagement_order_id = COALESCE($2::uuid, engagement_order_id),
           engagement_order_number = COALESCE($3::int, engagement_order_number),
           error_message = COALESCE($4, error_message)
       WHERE id = $5`,
      [status, engagement_order_id || null, engagement_order_number || null, error_message || null, req.params.id]
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // silently ignore if table doesn't exist
  }
}));

router.patch('/mass-orders/batches/:id', requireAuth, ah(async (req, res) => {
  try {
    const { status, success_count, failed_count } = req.body || {};
    await query(
      `UPDATE mass_order_batches
       SET status = COALESCE($1, status),
           success_count = COALESCE($2::int, success_count),
           failed_count  = COALESCE($3::int, failed_count)
       WHERE id = $4`,
      [status, success_count ?? null, failed_count ?? null, req.params.id]
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
}));

router.get('/mass-orders/batch-items', requireAuth, ah(async (req, res) => {
  const { batch_id } = req.query;
  if (!batch_id) return res.json([]);
  try {
    const { rows } = await query(
      `SELECT * FROM mass_order_batch_items WHERE batch_id = $1 ORDER BY created_at`,
      [batch_id]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
}));

// ── AI speed recommender (stub) ───────────────────────────────────────────────
router.post('/ai/speed-recommender', requireAuth, (_req, res) => {
  res.status(501).json({ error: 'AI recommender service is not available in this version.' });
});

// ── Chat conversations (get or create) ───────────────────────────────────────
router.post('/chat/conversations', requireAuth, ah(async (req, res) => {
  const { user_email, user_name } = req.body || {};
  try {
    // Return existing most-recent conversation
    const { rows: existing } = await query(
      `SELECT * FROM chat_conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.session.userId]
    );
    if (existing[0]) return res.json(existing[0]);
    // Create new
    const { rows: created } = await query(
      `INSERT INTO chat_conversations (user_id, user_email, user_name, status)
       VALUES ($1, $2, $3, 'open') RETURNING *`,
      [req.session.userId, user_email || '', user_name || null]
    );
    res.json(created[0]);
  } catch {
    // Table might not exist — return stub so UI doesn't crash
    res.json({ id: `stub-${req.session.userId}`, user_id: req.session.userId, status: 'open' });
  }
}));

// ── Instagram media (for MyPosts) ─────────────────────────────────────────────
router.get('/instagram/media', requireAuth, ah(async (req, res) => {
  const { account_id } = req.query;
  try {
    const { rows } = await query(
      `SELECT m.*, ia.username
       FROM instagram_media m
       JOIN instagram_accounts ia ON ia.id = m.account_id
       WHERE m.user_id = $1 ${account_id ? 'AND m.account_id = $2' : ''}
       ORDER BY m.posted_at DESC NULLS LAST LIMIT 100`,
      account_id ? [req.session.userId, account_id] : [req.session.userId]
    );
    res.json(rows);
  } catch { res.json([]); }
}));

// ── Support tickets ───────────────────────────────────────────────────────────
router.get('/support/tickets', requireAuth, ah(async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch { res.json([]); }
}));

router.post('/support/tickets', requireAuth, ah(async (req, res) => {
  const { subject, message, category, priority } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'subject and message required' });
  try {
    const { rows } = await query(
      `INSERT INTO support_tickets (user_id, subject, message, category, priority, status)
       VALUES ($1, $2, $3, $4, $5, 'open') RETURNING *`,
      [req.session.userId, subject, message, category || 'other', priority || 'medium']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create ticket' });
  }
}));

// ── Mass order batches ────────────────────────────────────────────────────────
router.get('/mass-orders/batches', requireAuth, ah(async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM mass_order_batches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.session.userId]
    );
    res.json(rows);
  } catch { res.json([]); }
}));

router.post('/mass-orders/batches', requireAuth, ah(async (req, res) => {
  const { name, platform, total_count, total_price } = req.body || {};
  try {
    const { rows } = await query(
      `INSERT INTO mass_order_batches (user_id, name, platform, total_count, status, total_price)
       VALUES ($1, $2, $3, $4, 'processing', $5) RETURNING *`,
      [req.session.userId, name || 'Batch', platform || null, total_count || 0, total_price || 0]
    );
    res.json(rows[0]);
  } catch (e) {
    // Table might not exist — return stub
    const { randomUUID } = await import('crypto');
    res.json({ id: randomUUID(), name: name || 'Batch', status: 'processing' });
  }
}));

router.post('/mass-orders/batch-items/bulk', requireAuth, ah(async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.json([]);
  try {
    const vals = items.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(',');
    const params = items.flatMap(it => [it.batch_id, it.link, it.price ?? 0, JSON.stringify(it.payload ?? {}), 'pending']);
    const { rows } = await query(
      `INSERT INTO mass_order_batch_items (batch_id, link, price, payload, status) VALUES ${vals} RETURNING *`,
      params
    );
    res.json(rows);
  } catch { res.json(items.map(it => ({ ...it, id: null }))); }
}));

export default router;
