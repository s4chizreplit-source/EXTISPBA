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
    fullName: row.profile_full_name || row.full_name || row.raw_user_meta_data?.full_name || '',
    role: row.role || 'user',
    createdAt: row.created_at,
  };
}

async function importedUserByEmail(email) {
  const { rows } = await query(
    `SELECT u.*, p.full_name AS profile_full_name,
            COALESCE(
              (SELECT CASE WHEN ur.role::text = 'admin' THEN 'admin' ELSE ur.role::text END
               FROM public.user_roles ur
               WHERE ur.user_id = u.id
               ORDER BY CASE WHEN ur.role::text = 'admin' THEN 0 ELSE 1 END
               LIMIT 1),
              'user'
            ) AS role
       FROM auth.users u
       LEFT JOIN public.profiles p ON p.user_id = u.id
      WHERE lower(u.email) = $1
        AND COALESCE(u.deleted_at IS NULL, true)
      ORDER BY u.created_at ASC
      LIMIT 1`,
    [email]
  );
  return rows[0];
}

async function importedUserById(id) {
  const { rows } = await query(
    `SELECT u.*, p.full_name AS profile_full_name,
            COALESCE(
              (SELECT CASE WHEN ur.role::text = 'admin' THEN 'admin' ELSE ur.role::text END
               FROM public.user_roles ur
               WHERE ur.user_id = u.id
               ORDER BY CASE WHEN ur.role::text = 'admin' THEN 0 ELSE 1 END
               LIMIT 1),
              'user'
            ) AS role
       FROM auth.users u
       LEFT JOIN public.profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [id]
  );
  return rows[0];
}

async function importedUserData(userId) {
  const [profile, wallet] = await Promise.all([
    query('SELECT * FROM public.profiles WHERE user_id = $1 LIMIT 1', [userId]),
    query('SELECT * FROM public.wallets WHERE user_id = $1 LIMIT 1', [userId]),
  ]);
  return { profile: profile.rows[0] || null, wallet: wallet.rows[0] || null };
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
    const user = await importedUserByEmail(email);
    const ok = user && user.encrypted_password && (await bcrypt.compare(password, user.encrypted_password));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.userId = user.id;
    req.session.role = user.role;
    const data = await importedUserData(user.id);
    res.json({ user: publicUser(user), ...data });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await importedUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const data = await importedUserData(user.id);
    res.json({ user: publicUser(user), ...data });
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
