import express from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ah, validate } from '../middleware/auth.js';

const router = express.Router();

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'telegram', 'facebook'];

router.get(
  '/',
  validate(
    z.object({
      platform: z.enum(['all', ...PLATFORMS]).default('all'),
      search: z.string().trim().max(120).optional(),
    }),
    'query'
  ),
  ah(async (req, res) => {
    const { platform, search } = req.valid;
    const { rows } = await query(
      `SELECT id, platform, category, name, description, price_per_1k,
              min_quantity, max_quantity
         FROM services
        WHERE is_active = true
          AND ($1 = 'all' OR platform = $1)
          AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR category ILIKE '%' || $2 || '%')
        ORDER BY platform, category, price_per_1k`,
      [platform, search || null]
    );
    res.json({
      platforms: PLATFORMS,
      services: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        category: r.category,
        name: r.name,
        description: r.description,
        pricePer1k: Number(r.price_per_1k),
        minQuantity: r.min_quantity,
        maxQuantity: r.max_quantity,
      })),
    });
  })
);

export default router;
