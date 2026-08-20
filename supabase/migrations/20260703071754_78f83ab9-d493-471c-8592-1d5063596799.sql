
CREATE OR REPLACE FUNCTION public.generate_telegram_link_code()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_code text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_code := upper(substring(md5(v_uid::text || random()::text || clock_timestamp()::text) from 1 for 8));
  INSERT INTO public.telegram_engagement_links (user_id, link_code, code_expires_at, status)
  VALUES (v_uid, v_code, now() + interval '30 minutes', 'pending')
  ON CONFLICT (user_id) DO UPDATE
    SET link_code = EXCLUDED.link_code,
        code_expires_at = EXCLUDED.code_expires_at,
        status = CASE WHEN telegram_engagement_links.status = 'linked' THEN 'linked' ELSE 'pending' END,
        updated_at = now();
  RETURN json_build_object('success', true, 'code', v_code, 'expires_at', now() + interval '30 minutes');
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_telegram_link_code(p_code text, p_chat_id bigint, p_username text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.telegram_engagement_links%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.telegram_engagement_links
    WHERE upper(link_code) = upper(p_code) LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'reason', 'invalid_code'); END IF;
  IF v_row.code_expires_at < now() THEN RETURN json_build_object('success', false, 'reason', 'expired'); END IF;

  UPDATE public.telegram_engagement_links
    SET telegram_chat_id = p_chat_id,
        telegram_username = p_username,
        status = 'linked',
        linked_at = now(),
        updated_at = now()
    WHERE id = v_row.id;
  RETURN json_build_object('success', true, 'user_id', v_row.user_id);
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_engagement_links_user_id_key'
  ) THEN
    ALTER TABLE public.telegram_engagement_links ADD CONSTRAINT telegram_engagement_links_user_id_key UNIQUE (user_id);
  END IF;
END $$;
