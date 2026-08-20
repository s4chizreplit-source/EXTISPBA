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
import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallet.js';
import serviceRoutes from './routes/services.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // the SPA loads its own assets/fonts
  })
);
app.use(express.json({ limit: '256kb' }));
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
    res.json({ ok: true, uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built SPA (dist/) with client-side routing fallback.
const distDir = path.resolve(__dirname, '..', '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.status(200).send('OrganicSMM Pro API is running. Build the frontend to serve the UI.')
  );
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`OrganicSMM Pro API listening on :${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000);
  });
}
