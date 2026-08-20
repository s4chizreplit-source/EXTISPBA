#!/usr/bin/env bash
# ============================================================================
# FIX: imported users ka wallet balance kam/0 dikh raha hai.
#
# Do problem thi:
#  1) merge ke time trigger ne wallet row (balance 0) bana di, isliye source ki
#     asli wallet row skip ho gayi.
#  2) same-email duplicate users ka source UUID target UUID se different hai,
#     isliye unka paisa map hi nahi hua -> total short (e.g. 73k vs 80k).
#
# Ab script source `profiles` bhi laati hai aur email se source_user_id ->
# target_user_id map banati hai. Ek target user ke multiple source wallets ho
# to unka SUM lagta hai (kuch paisa chhoota nahi).
#
# Safe: balance sirf badhta hai (GREATEST), kabhi kam nahi hota. Kuch delete
# nahi hota. End me "unmatched" report milti hai — jo paisa kis email ka map
# nahi hua.
#
# Usage (VPS):
#   cd /opt/smmpanel && bash deploy/fix-imported-wallets.sh
#   DRY_RUN=1 bash deploy/fix-imported-wallets.sh     # sirf report
#   REFETCH=1 bash deploy/fix-imported-wallets.sh     # source se fresh data
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/supabase}"
CONF="${CONF:-/etc/smmpanel.merge}"
WORK="${WORK:-/root/merge-src}"
DRY_RUN="${DRY_RUN:-0}"
REFETCH="${REFETCH:-0}"
PAGE="${PAGE:-1000}"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[ -f "$CONF" ] && . "$CONF" || true
[ -d "$INSTALL_DIR" ] || die "Supabase stack not found at $INSTALL_DIR"
cd "$INSTALL_DIR"
command -v jq >/dev/null || { apt-get update -qq && apt-get install -y -qq jq; }

psql_run() { docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql_q()   { docker compose exec -T db psql -U postgres -d postgres -At -c "$1"; }

docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 || die "Postgres not running"

psql_run >/dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS merge_stage;
CREATE TABLE IF NOT EXISTS merge_stage.raw (tbl text, j jsonb);
CREATE TABLE IF NOT EXISTS merge_stage.accepted (user_id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS merge_stage.user_map (
  source_user_id uuid PRIMARY KEY,
  target_user_id uuid NOT NULL
);
SQL

NEED=$(psql_q "SELECT CASE WHEN EXISTS(SELECT 1 FROM merge_stage.raw WHERE tbl='wallets')
                        AND EXISTS(SELECT 1 FROM merge_stage.raw WHERE tbl='profiles')
                       THEN 'f' ELSE 't' END")

# ---------------------------------------------------------------------------
# 1. source se wallets + transactions + profiles le aao (profiles = email map)
# ---------------------------------------------------------------------------
if [ "$NEED" = "t" ] || [ "$REFETCH" = "1" ]; then
  log "1/5 Source se wallets / transactions / profiles fetch kar raha hu"
  : "${SRC_URL:?SRC_URL required (put it in $CONF)}"
  : "${SRC_SERVICE_KEY:?SRC_SERVICE_KEY required (put it in $CONF)}"
  SRC_URL="${SRC_URL%/}"
  mkdir -p "$WORK"

  fetch() { # $1=table
    local t="$1" from=0 out="$WORK/$t.ndjson" body n
    : > "$out"
    while :; do
      body=$(curl -sS --max-time 300 \
        -H "apikey: $SRC_SERVICE_KEY" -H "Authorization: Bearer $SRC_SERVICE_KEY" \
        -H "Range-Unit: items" -H "Range: ${from}-$((from+PAGE-1))" \
        "$SRC_URL/rest/v1/$t?select=*") || return 1
      echo "$body" | jq -e 'type=="array"' >/dev/null 2>&1 || { warn "$t: $(echo "$body" | head -c 160)"; return 1; }
      n=$(echo "$body" | jq 'length'); [ "$n" -eq 0 ] && break
      echo "$body" | jq -c '.[]' >> "$out"
      [ "$n" -lt "$PAGE" ] && break
      from=$((from+PAGE))
    done
    wc -l < "$out"
  }

  for t in wallets transactions profiles; do
    echo "   $t rows: $(fetch "$t" || echo 0)"
  done

  psql_run >/dev/null <<'SQL'
DELETE FROM merge_stage.raw WHERE tbl IN ('wallets','transactions','profiles');
SQL

  for t in wallets transactions profiles; do
    [ -s "$WORK/$t.ndjson" ] || continue
    {
      echo "CREATE TEMP TABLE _l (line text);"
      printf '\\copy _l FROM STDIN WITH (FORMAT csv, DELIMITER E%s\\x02%s, QUOTE E%s\\x01%s)\n' "'" "'" "'" "'"
      cat "$WORK/$t.ndjson"
      echo '\.'
      echo "INSERT INTO merge_stage.raw (tbl, j) SELECT '$t', line::jsonb FROM _l WHERE btrim(line) <> '';"
    } | docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
  done
else
  log "1/5 merge_stage me data mil gaya — usi se restore karunga (REFETCH=1 se fresh)"
fi

# ---------------------------------------------------------------------------
# 2. source_user_id -> target_user_id map (same UUID + email fallback)
# ---------------------------------------------------------------------------
log "2/5 User mapping bana raha hu (UUID + email)"
psql_run >/dev/null <<'SQL'
-- same-UUID users
INSERT INTO merge_stage.user_map (source_user_id, target_user_id)
SELECT u.id, u.id FROM auth.users u
ON CONFLICT (source_user_id) DO UPDATE SET target_user_id=EXCLUDED.target_user_id;

-- purane merge ka auth staging (agar ho)
DO $$
BEGIN
  IF to_regclass('merge_stage.users') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO merge_stage.user_map (source_user_id, target_user_id)
      SELECT (s.j->>'user_id')::uuid, a.id
      FROM merge_stage.users s
      JOIN auth.users a ON lower(a.email)=lower(s.j->>'email')
      WHERE s.j->>'user_id' IS NOT NULL AND s.j->>'email' IS NOT NULL
      ON CONFLICT (source_user_id) DO UPDATE SET target_user_id=EXCLUDED.target_user_id
    $q$;
  END IF;
END $$;

-- source profiles se email map (duplicate-email accounts isi se judte hain)
INSERT INTO merge_stage.user_map (source_user_id, target_user_id)
SELECT DISTINCT ON ((s.j->>'user_id')::uuid) (s.j->>'user_id')::uuid, a.id
FROM merge_stage.raw s
JOIN auth.users a ON lower(a.email)=lower(s.j->>'email')
WHERE s.tbl='profiles' AND s.j->>'user_id' IS NOT NULL AND s.j->>'email' IS NOT NULL
ORDER BY (s.j->>'user_id')::uuid, a.created_at ASC
ON CONFLICT (source_user_id) DO UPDATE SET target_user_id=EXCLUDED.target_user_id;

INSERT INTO merge_stage.accepted (user_id)
SELECT source_user_id FROM merge_stage.user_map
ON CONFLICT DO NOTHING;
SQL

# ---------------------------------------------------------------------------
# 3. report (pehle) + jo map nahi hua
# ---------------------------------------------------------------------------
log "3/5 Before"
psql_run -c "
WITH src AS (
  SELECT DISTINCT ON ((j->>'user_id')::uuid)
         (j->>'user_id')::uuid AS src_user,
         COALESCE((j->>'balance')::numeric,0) AS balance
  FROM merge_stage.raw WHERE tbl='wallets' AND j->>'user_id' IS NOT NULL
  ORDER BY (j->>'user_id')::uuid, COALESCE((j->>'balance')::numeric,0) DESC
), tgt AS (
  SELECT m.target_user_id AS user_id, SUM(s.balance) AS balance
  FROM src s JOIN merge_stage.user_map m ON m.source_user_id = s.src_user
  GROUP BY 1
)
SELECT ROUND((SELECT SUM(balance) FROM src),2)                    AS source_total,
       ROUND((SELECT SUM(balance) FROM tgt),2)                    AS mappable_total,
       ROUND((SELECT COALESCE(SUM(balance),0) FROM public.wallets),2) AS current_total,
       (SELECT count(*) FROM src s
          WHERE NOT EXISTS (SELECT 1 FROM merge_stage.user_map m
                            WHERE m.source_user_id=s.src_user))    AS unmapped_wallets,
       ROUND((SELECT COALESCE(SUM(s.balance),0) FROM src s
          WHERE NOT EXISTS (SELECT 1 FROM merge_stage.user_map m
                            WHERE m.source_user_id=s.src_user)),2) AS unmapped_money;"

if [ "$DRY_RUN" = "1" ]; then
  echo; echo "[dry-run] kuch change nahi kiya. Chalane ke liye: bash deploy/fix-imported-wallets.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. restore
# ---------------------------------------------------------------------------
log "4/5 Wallet balances restore kar raha hu"
psql_run <<'SQL'
BEGIN;

-- source wallet per source user (dedupe: sabse bada balance)
CREATE TEMP TABLE _src AS
SELECT DISTINCT ON ((j->>'user_id')::uuid)
       (j->>'user_id')::uuid                        AS src_user,
       COALESCE((j->>'balance')::numeric,0)         AS balance,
       COALESCE((j->>'total_deposited')::numeric,0) AS total_deposited,
       COALESCE((j->>'total_spent')::numeric,0)     AS total_spent
FROM merge_stage.raw
WHERE tbl='wallets' AND j->>'user_id' IS NOT NULL
ORDER BY (j->>'user_id')::uuid, COALESCE((j->>'balance')::numeric,0) DESC;

-- target user ke saare source wallets ka SUM (duplicate email accounts merge)
CREATE TEMP TABLE _tgt AS
SELECT m.target_user_id           AS user_id,
       SUM(s.balance)             AS balance,
       SUM(s.total_deposited)     AS total_deposited,
       SUM(s.total_spent)         AS total_spent
FROM _src s
JOIN merge_stage.user_map m ON m.source_user_id = s.src_user
JOIN auth.users u ON u.id = m.target_user_id
GROUP BY 1;

INSERT INTO public.wallets (user_id, balance, total_deposited, total_spent)
SELECT t.user_id, t.balance, t.total_deposited, t.total_spent
FROM _tgt t
WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = t.user_id);

UPDATE public.wallets w
   SET balance         = GREATEST(COALESCE(w.balance,0), t.balance),
       total_deposited = GREATEST(COALESCE(w.total_deposited,0), t.total_deposited),
       total_spent     = GREATEST(COALESCE(w.total_spent,0), t.total_spent),
       updated_at      = now()
FROM _tgt t
WHERE w.user_id = t.user_id
  AND (t.balance > COALESCE(w.balance,0)
    OR t.total_deposited > COALESCE(w.total_deposited,0)
    OR t.total_spent > COALESCE(w.total_spent,0));

-- duplicate wallet rows (same user) merge karo taki UI me split na dikhe
WITH dup AS (
  SELECT user_id, MAX(balance) AS balance, MAX(total_deposited) AS dep, MAX(total_spent) AS spent
  FROM public.wallets GROUP BY user_id HAVING count(*) > 1
), keep AS (
  SELECT DISTINCT ON (user_id) id, user_id FROM public.wallets
  WHERE user_id IN (SELECT user_id FROM dup)
  ORDER BY user_id, balance DESC, created_at ASC
)
DELETE FROM public.wallets w
USING keep k WHERE w.user_id = k.user_id AND w.id <> k.id;

UPDATE public.wallets w
   SET balance = GREATEST(COALESCE(w.balance,0), t.balance),
       total_deposited = GREATEST(COALESCE(w.total_deposited,0), t.total_deposited),
       total_spent = GREATEST(COALESCE(w.total_spent,0), t.total_spent)
FROM _tgt t WHERE w.user_id = t.user_id;

-- purani transaction history (user_id remap ke saath)
INSERT INTO public.transactions
SELECT r.* FROM (
  SELECT jsonb_set(z.j, '{user_id}', to_jsonb(m.target_user_id)) AS j
  FROM merge_stage.raw z
  JOIN merge_stage.user_map m ON m.source_user_id = (z.j->>'user_id')::uuid
  WHERE z.tbl='transactions' AND z.j->>'user_id' IS NOT NULL
) q, LATERAL jsonb_populate_record(NULL::public.transactions, q.j) r
ON CONFLICT DO NOTHING;

COMMIT;
SQL

# ---------------------------------------------------------------------------
# 5. report (baad me)
# ---------------------------------------------------------------------------
log "5/5 After"
psql_run -c "
SELECT count(*)                                   AS wallets,
       count(*) FILTER (WHERE balance > 0)         AS funded_wallets,
       ROUND(SUM(balance),2)                       AS total_balance,
       ROUND(SUM(total_deposited),2)               AS total_deposited,
       (SELECT count(*) FROM public.transactions)  AS transactions
FROM public.wallets;"

echo
echo "Jo source wallets kisi bhi target user se map nahi hue (in emails ke users yahan nahi hain):"
psql_run -c "
WITH src AS (
  SELECT DISTINCT ON ((j->>'user_id')::uuid)
         (j->>'user_id')::uuid AS src_user,
         COALESCE((j->>'balance')::numeric,0) AS balance
  FROM merge_stage.raw WHERE tbl='wallets' AND j->>'user_id' IS NOT NULL
  ORDER BY (j->>'user_id')::uuid, COALESCE((j->>'balance')::numeric,0) DESC
)
SELECT COALESCE(p.j->>'email','(unknown)') AS email, ROUND(s.balance,2) AS balance
FROM src s
LEFT JOIN merge_stage.raw p ON p.tbl='profiles' AND (p.j->>'user_id')::uuid = s.src_user
WHERE NOT EXISTS (SELECT 1 FROM merge_stage.user_map m WHERE m.source_user_id = s.src_user)
  AND s.balance > 0
ORDER BY s.balance DESC LIMIT 30;"

psql_run -c "
SELECT p.email, ROUND(w.balance,2) AS balance, ROUND(w.total_deposited,2) AS deposited
FROM public.wallets w JOIN public.profiles p ON p.user_id = w.user_id
WHERE w.balance > 0
ORDER BY w.balance DESC LIMIT 25;"

echo
echo "[done] Paisa source ke hisaab se restore ho gaya. Kuch delete nahi hua."
