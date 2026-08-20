import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query, withTx } from '../db.js';
import { ah, validate, requireAuth } from '../middleware/auth.js';

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true });

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(512),
  fullName: z.string().trim().max(120).optional(),
});

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

router.post(
  '/signup',
  authLimiter,
  validate(credentials),
  ah(async (req, res) => {
    const { email, password, fullName } = req.valid;
    const hash = await bcrypt.hash(password, 12);

    const user = await withTx(async (client) => {
      const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (existing.rowCount) {
        const err = new Error('Email already registered');
        err.status = 409;
        throw err;
      }
      // First ever account becomes admin so the panel is manageable right after deploy.
      const count = await client.query('SELECT count(*)::int AS n FROM users');
      const role = count.rows[0].n === 0 ? 'admin' : 'user';

      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [email, hash, fullName || '', role]
      );
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [inserted.rows[0].id]);
      return inserted.rows[0];
    });

    req.session.userId = user.id;
    req.session.role = user.role;
    res.status(201).json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  authLimiter,
  validate(credentials.pick({ email: true, password: true })),
  ah(async (req, res) => {
    const { email, password } = req.valid;
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ user: publicUser(user) });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user: publicUser(rows[0]) });
  })
);

router.post(
  '/forgot-password',
  authLimiter,
  validate(z.object({ email: z.string().trim().toLowerCase().email() })),
  ah(async (req, res) => {
    const { rows } = await query('SELECT id FROM users WHERE email = $1', [req.valid.email]);
    let resetUrl;
    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `INSERT INTO password_resets (token, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [token, rows[0].id]
      );
      resetUrl = `${process.env.PUBLIC_APP_URL || ''}/reset-password?token=${token}`;
      // No mailer is bundled. Wire your SMTP/provider here; the link is logged for now.
      console.log(`[password-reset] ${req.valid.email} -> ${resetUrl}`);
    }
    // Always the same answer so emails can't be enumerated.
    res.json({ ok: true, ...(process.env.EXPOSE_RESET_LINK === 'true' && resetUrl ? { resetUrl } : {}) });
  })
);

router.post(
  '/reset-password',
  authLimiter,
  validate(z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(512) })),
  ah(async (req, res) => {
    const { token, password } = req.valid;
    const hash = await bcrypt.hash(password, 12);
    const updated = await withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT user_id FROM password_resets
          WHERE token = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [token]
      );
      if (!rows[0]) return false;
      await client.query('UPDATE password_resets SET used_at = now() WHERE token = $1', [token]);
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
        hash,
        rows[0].user_id,
      ]);
      return true;
    });
    if (!updated) return res.status(400).json({ error: 'Invalid or expired reset token' });
    res.json({ ok: true });
  })
);

export default router;
