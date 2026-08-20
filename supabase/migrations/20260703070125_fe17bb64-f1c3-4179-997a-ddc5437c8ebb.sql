
-- === instagram_accounts ===
CREATE TABLE public.instagram_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  ig_user_id text,
  full_name text,
  avatar_url text,
  followers int DEFAULT 0,
  following int DEFAULT 0,
  posts_count int DEFAULT 0,
  is_private boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  biography text,
  status text NOT NULL DEFAULT 'active',
  auto_boost_enabled boolean DEFAULT false,
  default_bundle_id uuid REFERENCES public.engagement_bundles(id) ON DELETE SET NULL,
  last_scraped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, username)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_accounts TO authenticated;
GRANT ALL ON public.instagram_accounts TO service_role;
ALTER TABLE public.instagram_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own or admin select ig accounts" ON public.instagram_accounts
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "own insert ig accounts" ON public.instagram_accounts
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own update ig accounts" ON public.instagram_accounts
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "own delete ig accounts" ON public.instagram_accounts
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_ig_accounts_updated
  BEFORE UPDATE ON public.instagram_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === instagram_media ===
CREATE TABLE public.instagram_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  shortcode text,
  media_type text,
  permalink text NOT NULL,
  thumbnail_url text,
  caption text,
  like_count int DEFAULT 0,
  comment_count int DEFAULT 0,
  view_count int DEFAULT 0,
  posted_at timestamptz,
  engagement_applied boolean NOT NULL DEFAULT false,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, media_id)
);
CREATE INDEX idx_ig_media_account_posted ON public.instagram_media(account_id, posted_at DESC);
CREATE INDEX idx_ig_media_user_shortcode ON public.instagram_media(user_id, shortcode);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_media TO authenticated;
GRANT ALL ON public.instagram_media TO service_role;
ALTER TABLE public.instagram_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own or admin select ig media" ON public.instagram_media
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "own insert ig media" ON public.instagram_media
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own update ig media" ON public.instagram_media
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "own delete ig media" ON public.instagram_media
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_ig_media_updated
  BEFORE UPDATE ON public.instagram_media
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === telegram_engagement_links ===
CREATE TABLE public.telegram_engagement_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id bigint,
  telegram_username text,
  link_code text UNIQUE,
  code_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tg_eng_chat ON public.telegram_engagement_links(telegram_chat_id) WHERE status = 'linked';
CREATE INDEX idx_tg_eng_user ON public.telegram_engagement_links(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_engagement_links TO authenticated;
GRANT ALL ON public.telegram_engagement_links TO service_role;
ALTER TABLE public.telegram_engagement_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own or admin select tg links" ON public.telegram_engagement_links
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "own insert tg links" ON public.telegram_engagement_links
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own update tg links" ON public.telegram_engagement_links
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "own delete tg links" ON public.telegram_engagement_links
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_tg_eng_links_updated
  BEFORE UPDATE ON public.telegram_engagement_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === RPC: posts with order summary ===
CREATE OR REPLACE FUNCTION public.get_posts_with_order_summary(_user_id uuid)
RETURNS TABLE(
  media_id text,
  shortcode text,
  permalink text,
  thumbnail_url text,
  media_type text,
  caption text,
  posted_at timestamptz,
  account_username text,
  total_orders bigint,
  active_orders bigint,
  completed_orders bigint,
  total_spent numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.media_id, m.shortcode, m.permalink, m.thumbnail_url, m.media_type,
         m.caption, m.posted_at,
         a.username AS account_username,
         COUNT(o.id) AS total_orders,
         COUNT(o.id) FILTER (WHERE o.status IN ('pending','processing')) AS active_orders,
         COUNT(o.id) FILTER (WHERE o.status = 'completed') AS completed_orders,
         COALESCE(SUM(o.total_price), 0) AS total_spent
  FROM public.instagram_media m
  JOIN public.instagram_accounts a ON a.id = m.account_id
  LEFT JOIN public.engagement_orders o
    ON o.user_id = m.user_id
   AND m.shortcode IS NOT NULL
   AND o.link ILIKE '%' || m.shortcode || '%'
  WHERE m.user_id = _user_id
    AND (auth.uid() = _user_id OR public.has_role(auth.uid(), 'admin'))
  GROUP BY m.media_id, m.shortcode, m.permalink, m.thumbnail_url, m.media_type,
           m.caption, m.posted_at, a.username
  ORDER BY m.posted_at DESC NULLS LAST;
$$;

-- === RPC: orders for a specific link/shortcode ===
CREATE OR REPLACE FUNCTION public.get_orders_by_link(_user_id uuid, _link text)
RETURNS SETOF public.engagement_orders
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.engagement_orders
  WHERE user_id = _user_id
    AND (auth.uid() = _user_id OR public.has_role(auth.uid(), 'admin'))
    AND (
      link = _link
      OR (position('/p/' IN _link) > 0 AND link ILIKE '%' || split_part(split_part(_link, '/p/', 2), '/', 1) || '%')
      OR (position('/reel/' IN _link) > 0 AND link ILIKE '%' || split_part(split_part(_link, '/reel/', 2), '/', 1) || '%')
    )
  ORDER BY created_at DESC;
$$;
