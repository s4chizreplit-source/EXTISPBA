#!/usr/bin/env bash
# Kya bacha hai / kya gaya hai — full audit + jo bacha hai use naye user id se re-link karo.
set -euo pipefail
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
cd "$SUPA_DIR"
EMAIL_LC="$(printf '%s' "${EMAIL:-zyrofit.my@gmail.com}" | tr '[:upper:]' '[:lower:]')"

q() { docker compose exec -T db psql -U postgres -d postgres -c "$1"; }
q1() { docker compose exec -T db psql -U postgres -d postgres -tAc "$1"; }

NEW_ID="$(q1 "SELECT id FROM auth.users WHERE lower(email)='${EMAIL_LC}' LIMIT 1")"
echo "current user id: $NEW_ID"

echo; echo "=== USERS ==="
q "SELECT id, email, created_at FROM auth.users ORDER BY created_at;"

echo "=== PROVIDER ACCOUNTS (admin data, user se linked nahi) ==="
q "SELECT id, name, provider_id, is_active, (api_key IS NOT NULL) AS has_key FROM public.provider_accounts;"

echo "=== SERVICES / MAPPINGS ==="
q "SELECT count(*) AS services FROM public.services;"
q "SELECT count(*) AS mappings FROM public.service_provider_mapping;"

echo "=== WALLETS ==="
q "SELECT user_id, balance, total_deposited, total_spent FROM public.wallets;"

echo "=== TRANSACTIONS (last 20) ==="
q "SELECT user_id, type, amount, status, payment_method, created_at FROM public.transactions ORDER BY created_at DESC LIMIT 20;"

echo "=== ORDERS / ENGAGEMENT ORDERS ==="
q "SELECT count(*) AS orders FROM public.orders;"
q "SELECT count(*) AS engagement_orders FROM public.engagement_orders;"

echo "=== ORPHAN ROWS (user delete hone ke baad bache hue) ==="
q "SELECT 'wallets' t, count(*) FROM public.wallets w WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=w.user_id)
UNION ALL SELECT 'transactions', count(*) FROM public.transactions x WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=x.user_id)
UNION ALL SELECT 'orders', count(*) FROM public.orders o WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=o.user_id)
UNION ALL SELECT 'engagement_orders', count(*) FROM public.engagement_orders e WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=e.user_id);"

if [ "${RELINK:-0}" = "1" ] && [ -n "$NEW_ID" ]; then
  echo; echo "=== RE-LINKING orphan rows -> $NEW_ID ==="
  docker compose exec -T db psql -U postgres -d postgres <<SQL
UPDATE public.transactions x SET user_id='${NEW_ID}' WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=x.user_id);
UPDATE public.orders o SET user_id='${NEW_ID}' WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=o.user_id);
UPDATE public.engagement_orders e SET user_id='${NEW_ID}' WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=e.user_id);
DELETE FROM public.wallets w WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=w.user_id)
  AND EXISTS (SELECT 1 FROM public.wallets w2 WHERE w2.user_id='${NEW_ID}');
UPDATE public.wallets w SET user_id='${NEW_ID}' WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id=w.user_id);
SQL
  q "SELECT balance, total_deposited FROM public.wallets WHERE user_id='${NEW_ID}';"
fi

if [ -n "${SET_BALANCE:-}" ] && [ -n "$NEW_ID" ]; then
  echo; echo "=== SETTING WALLET BALANCE = ${SET_BALANCE} USD ==="
  docker compose exec -T db psql -U postgres -d postgres <<SQL
INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
VALUES ('${NEW_ID}', ${SET_BALANCE}, ${SET_BALANCE}, 0)
ON CONFLICT (user_id) DO UPDATE SET balance=${SET_BALANCE}, total_deposited=GREATEST(public.wallets.total_deposited, ${SET_BALANCE});
INSERT INTO public.transactions (user_id, type, amount, balance_after, status, payment_method, description)
VALUES ('${NEW_ID}', 'deposit', ${SET_BALANCE}, ${SET_BALANCE}, 'completed', 'admin', 'Balance restore (migration fix)');
SQL
  q "SELECT balance, total_deposited FROM public.wallets WHERE user_id='${NEW_ID}';"
fi
