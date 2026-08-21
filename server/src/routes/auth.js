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
  // Try public.auth_users first (works in all environments including production).
  // Fall back to auth.users for dev environments that haven't migrated yet.
  for (const tbl of ['public.auth_users', 'auth.users']) {
    try {
      const { rows } = await query(
        `SELECT u.id, u.email, u.encrypted_password, u.raw_user_meta_data, u.created_at,
                p.full_name AS profile_full_name,
                COALESCE(
                  (SELECT ur.role::text FROM public.user_roles ur
                    WHERE ur.user_id = u.id
                    ORDER BY CASE WHEN ur.role::text = 'admin' THEN 0 ELSE 1 END LIMIT 1),
                  'user'
                ) AS role
           FROM ${tbl} u
           LEFT JOIN public.profiles p ON p.user_id = u.id
          WHERE lower(u.email) = $1
          LIMIT 1`,
        [email]
      );
      if (rows[0]) return rows[0];
      // Table exists but no row — stop searching
      return null;
    } catch (e) {
      if (e.code === '42P01') continue; // table missing, try next
      throw e;
    }
  }
  return null;
}

async function importedUserById(id) {
  for (const tbl of ['public.auth_users', 'auth.users']) {
    try {
      const { rows } = await query(
        `SELECT u.id, u.email, u.encrypted_password, u.raw_user_meta_data, u.created_at,
                p.full_name AS profile_full_name,
                COALESCE(
                  (SELECT ur.role::text FROM public.user_roles ur
                    WHERE ur.user_id = u.id
                    ORDER BY CASE WHEN ur.role::text = 'admin' THEN 0 ELSE 1 END LIMIT 1),
                  'user'
                ) AS role
           FROM ${tbl} u
           LEFT JOIN public.profiles p ON p.user_id = u.id
          WHERE u.id = $1
          LIMIT 1`,
        [id]
      );
      if (rows[0]) return rows[0];
      return null;
    } catch (e) {
      if (e.code === '42P01') continue;
      throw e;
    }
  }
  return null;
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
      const existing = await client.query('SELECT 1 FROM auth_users WHERE lower(email) = $1', [email]);
      if (existing.rowCount) {
        const err = new Error('Email already registered');
        err.status = 409;
        throw err;
      }
      // First ever account becomes admin so the panel is manageable right after deploy.
      const count = await client.query('SELECT count(*)::int AS n FROM auth_users');
      const role = count.rows[0].n === 0 ? 'admin' : 'user';

      // auth_users uses VPS Supabase schema: encrypted_password + raw_user_meta_data
      const { rows: [inserted] } = await client.query(
        `INSERT INTO auth_users (id, email, encrypted_password, raw_user_meta_data)
         VALUES (gen_random_uuid(), $1, $2, $3)
         RETURNING id, email, created_at`,
        [email, hash, JSON.stringify({ full_name: fullName || '', role })]
      );

      // Keep the imported auth schema as the FK identity anchor while the
      // application authenticates against public.auth_users.
      await client.query(
        `INSERT INTO auth.users
           (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          inserted.id,
          email,
          hash,
          JSON.stringify({ full_name: fullName || '', role }),
          inserted.created_at,
        ]
      );

      // Role stored in user_roles table (same pattern as VPS users)
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
         ON CONFLICT (user_id, role) DO NOTHING`,
        [inserted.id, role]
      );

      // Create profile
      await client.query(
        `INSERT INTO profiles (user_id, email, full_name) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
        [inserted.id, email, fullName || '']
      );

      // Create wallet
      await client.query(
        'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [inserted.id]
      );

      return { ...inserted, role };
    });

    req.session.userId = user.id;
    req.session.role = user.role;
    res.status(201).json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  authLimiter,
  validate(z.object({ email: z.string().trim().toLowerCase().email().max(255), password: z.string().min(1).max(512) })),
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
    const { rows } = await query('SELECT id FROM auth_users WHERE email = $1', [req.valid.email]);
    let resetUrl;
    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `INSERT INTO password_resets (token, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [token, rows[0].id]
      );
      const configuredBaseUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
      const requestBaseUrl = `${req.protocol}://${req.get('host')}`;
      resetUrl = `${configuredBaseUrl || requestBaseUrl}/reset-password?token=${token}`;
      // No mailer is bundled. Wire your SMTP/provider here; the link is logged for now.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[password-reset] generated development reset link for ${req.valid.email}`);
      }
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
      await client.query('UPDATE auth_users SET encrypted_password = $1 WHERE id = $2', [
        hash,
        rows[0].user_id,
      ]);
      return true;
    });
    if (!updated) return res.status(400).json({ error: 'Invalid or expired reset token' });
    res.json({ ok: true });
  })
);

// PATCH /profile — update full_name
router.patch(
  '/profile',
  requireAuth,
  validate(z.object({ fullName: z.string().trim().min(1).max(120) })),
  ah(async (req, res) => {
    await query(
      `UPDATE profiles SET full_name = $1, updated_at = now() WHERE user_id = $2`,
      [req.valid.fullName, req.session.userId]
    );
    res.json({ ok: true });
  })
);

// POST /change-password
router.post(
  '/change-password',
  requireAuth,
  validate(z.object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(8).max(512),
  })),
  ah(async (req, res) => {
    const { currentPassword, newPassword } = req.valid;
    const { rows } = await query(
      'SELECT encrypted_password FROM auth_users WHERE id = $1',
      [req.session.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, rows[0].encrypted_password);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE auth_users SET encrypted_password = $1 WHERE id = $2', [hash, req.session.userId]);
    res.json({ ok: true });
  })
);

// PATCH /api-key — save new api key to profiles
router.patch(
  '/api-key',
  requireAuth,
  validate(z.object({ apiKey: z.string().min(10).max(200) })),
  ah(async (req, res) => {
    await query(
      `UPDATE profiles SET api_key = $1, updated_at = now() WHERE user_id = $2`,
      [req.valid.apiKey, req.session.userId]
    );
    res.json({ ok: true });
  })
);

export default router;
