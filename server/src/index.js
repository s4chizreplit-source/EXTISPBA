import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import pgSimple from 'connect-pg-simple';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pool, query } from './db.js';
import { requireAuth, ah } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallet.js';
import serviceRoutes from './routes/services.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import engagementOrderRoutes from './routes/engagement-orders.js';
import createEngagementOrderRoutes from './routes/create-engagement-order.js';
import {
  requireEngagementOrderReadiness,
} from './middleware/engagementOrderReadiness.js';
import zapupiRoutes from './routes/zapupi.js';
import oxapayRoutes from './routes/oxapay.js';
import bundleRoutes from './routes/bundles.js';
import userAdminRoutes from './routes/users.js';
import stubRoutes from './routes/stubs.js';
import { startCron } from './cron.js';
import { seedAuthUsers } from './seeds/seedAuthUsers.js';
import { seedAllData } from './seeds/seedAllData.js';
import { areEngagementOrderWritesReady } from './seeds/historicalOrderSeed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// ── Static assets + health-check root BEFORE session middleware ────────────
// GCE startup probe hits GET / — serve it instantly without any DB round-trip.
const distDir = path.resolve(__dirname, '..', '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  app.get('/', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.status(200).send('OrganicSMM Pro API is running.')
  );
}

app.use(
  helmet({
    contentSecurityPolicy: false, // the SPA loads its own assets/fonts
  })
);
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buffer) => {
    if (req.originalUrl?.startsWith('/api/oxapay/webhook')) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(cookieParser());

const PgStore = pgSimple(session);
app.use(
  session({
    store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
    name: 'smmpanel.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

app.get('/healthz', async (_req, res) => {
  try {
    await query('SELECT 1');
    if (!areEngagementOrderWritesReady()) {
      return res.status(503).json({
        ok: false,
        ready: false,
        error: 'Historical engagement orders are not ready',
      });
    }
    res.json({ ok: true, uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', orderRoutes);
// Specific sub-paths first, then the broad /api/admin catch-all
app.use('/api/admin/bundles', bundleRoutes);
app.use('/api/admin/users', userAdminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/engagement-orders', requireEngagementOrderReadiness);
app.use('/api/engagement-orders', createEngagementOrderRoutes);
app.use('/api/engagement-orders', engagementOrderRoutes);
app.use('/api/zapupi', zapupiRoutes);
app.use('/api/oxapay', oxapayRoutes);
app.use('/api', stubRoutes);

// ─── Public (user-facing) bundles endpoint ────────────────────────────────
app.get('/api/bundles', requireAuth, ah(async (req, res) => {
  const platform = req.query.platform || null;
  const { rows: bundles } = await query(
    `SELECT * FROM engagement_bundles WHERE is_active = true ${platform ? 'AND platform = $1' : ''} ORDER BY sort_order, created_at`,
    platform ? [platform] : []
  );
  if (bundles.length === 0) return res.json([]);
  const ids = bundles.map(b => b.id);
  const { rows: items } = await query(
    `SELECT bi.*,
            s.id AS svc_id, s.name AS svc_name, s.price AS svc_price,
            s.min_quantity AS svc_min, s.max_quantity AS svc_max
       FROM bundle_items bi
       LEFT JOIN services s ON s.id = bi.service_id
      WHERE bi.bundle_id = ANY($1::uuid[])
      ORDER BY bi.sort_order`,
    [ids]
  );
  const byBundle = {};
  for (const it of items) {
    if (!byBundle[it.bundle_id]) byBundle[it.bundle_id] = [];
    byBundle[it.bundle_id].push({
      ...it,
      service: it.svc_id ? { id: it.svc_id, name: it.svc_name, price: it.svc_price, min_quantity: it.svc_min, max_quantity: it.svc_max } : null,
    });
  }
  res.json(bundles.map(b => ({ ...b, items: byBundle[b.id] || [] })));
}));

// Dashboard stats — single DB round-trip
app.get(
  '/api/dashboard/stats',
  requireAuth,
  requireEngagementOrderReadiness,
  ah(async (req, res) => {
    const uid = req.session.userId;
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE src = 'order') AS total_orders,
         COUNT(*) FILTER (WHERE src = 'order' AND status = 'completed') AS completed_orders,
         COUNT(*) FILTER (WHERE src = 'order' AND status IN ('pending','processing')) AS active_orders,
         COALESCE(SUM(price) FILTER (WHERE src = 'order'), 0) AS total_spent
       FROM (
         SELECT 'order' AS src, status, price::numeric AS price FROM orders WHERE user_id = $1
         UNION ALL
         SELECT 'order', status, total_price::numeric FROM engagement_orders WHERE user_id = $1
       ) t`,
      [uid]
    );
    const r = rows[0];
    res.json({
      totalOrders:     Number(r.total_orders),
      completedOrders: Number(r.completed_orders),
      activeOrders:    Number(r.active_orders),
      totalSpent:      Number(r.total_spent),
    });
  })
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// SPA fallback for client-side routing (non-API, non-asset paths like /dashboard, /orders, etc.)
if (fs.existsSync(distDir)) {
  app.get(/.*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`OrganicSMM Pro API listening on :${PORT}`);
  seedAuthUsers()
    .then(() => seedAllData())
    .then(() => startCron())
    .catch(e => {
      console.error('[startup] critical data readiness failed:', e.message);
    });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000);
  });
}
