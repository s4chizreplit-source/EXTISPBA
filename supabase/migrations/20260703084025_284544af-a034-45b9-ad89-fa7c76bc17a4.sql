
REVOKE EXECUTE ON FUNCTION public.get_posts_with_order_summary(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_orders_by_link(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_telegram_link_code() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_telegram_link_code(text, bigint, text) FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_posts_with_order_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_orders_by_link(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_telegram_link_code() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_telegram_link_code(text, bigint, text) TO service_role;
