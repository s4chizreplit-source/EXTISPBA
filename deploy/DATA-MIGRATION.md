# Full Data Transfer — Lovable Cloud → Self-Hosted Supabase (VPS)

Yeh guide poora data + schema VPS pe 1:1 copy karne ke liye hai.

---

## Step 1 — Data export karo (yeh aapko manually karna hoga)

Lovable app mein:

**Cloud → Advanced settings → Export data**

Yahan se dump download hoga (`.sql` ya CSVs ka `.tar.gz`). Isko VPS pe upload karo:

```bash
scp dump.sql root@YOUR_VPS_IP:/root/dump.sql
```

> Security policy ki wajah se main aapke database ka dump khud nahi le sakta —
> export sirf Lovable ke Export data page se hota hai.

---

## Step 2 — VPS pe full Supabase stack install karo

Ek command (root user):

```bash
curl -fsSL https://raw.githubusercontent.com/xbhisofy/whopxbot/main/deploy/supabase-selfhost.sh | bash
```

Domain ke saath (auto-HTTPS chahiye to):

```bash
curl -fsSL https://raw.githubusercontent.com/xbhisofy/whopxbot/main/deploy/supabase-selfhost.sh \
  | DOMAIN=api.apna-domain.com bash
```

Yeh install karega:

| Component | Kaam |
|---|---|
| Postgres 15 | Database |
| GoTrue (Auth) | Email/password login, JWT |
| PostgREST | Data API (`supabase.from(...)`) |
| Storage API | File buckets |
| Realtime | Live subscriptions |
| Edge Runtime | Deno edge functions |
| Studio | Admin dashboard (`http://IP:8000`) |
| Kong | API gateway |

Uske baad script **aapki saari 143 migrations** apply karega — matlab tables,
RLS policies, database functions, triggers sab exactly same ban jaayenge.

Script end mein credentials print karega:
`API_EXTERNAL_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_PASSWORD`.
**Inko save kar lo.**

---

## Step 3 — Data import karo

```bash
bash /opt/smmpanel/deploy/import-data.sh /root/dump.sql
```

CSV archive ho to:

```bash
bash /opt/smmpanel/deploy/import-data.sh /root/dump.tar.gz
```

Script FK checks temporarily off karta hai, correct order mein tables bharta hai,
aur end mein sequences reset karke row counts dikhata hai.

---

## Step 4 — Frontend ko naye backend pe point karo

```bash
nano /opt/smmpanel/.env
```

```env
VITE_SUPABASE_URL=https://api.apna-domain.com   # ya http://IP:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
VITE_SUPABASE_PROJECT_ID=selfhosted
```

Build:

```bash
cd /opt/smmpanel && pnpm install && pnpm run build
```

---

## Step 5 — Edge functions deploy karo

Saare 43 functions:

```bash
cd /opt/smmpanel
npx supabase functions deploy --all --project-ref selfhosted
```

Secrets set karo (jo Cloud pe the):

```bash
cd /opt/supabase
nano .env   # end mein add karo:
```

```env
OXAPAY_MERCHANT_API_KEY=...
ZAPUPI_ZAP_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_BOT_USERNAME=...
RAZORPAY_WEBHOOK_SECRET=...
APIFY_API_TOKEN=...
LOVABLE_API_KEY=...
```

```bash
docker compose up -d --force-recreate functions
```

---

## Step 6 — Webhook URLs update karo

Payment providers ke dashboard mein callback URL badlo:

| Provider | Naya URL |
|---|---|
| OxaPay | `https://api.apna-domain.com/functions/v1/oxapay-webhook` |
| ZapUPI | `https://api.apna-domain.com/functions/v1/zapupi-webhook` |
| Razorpay | `https://api.apna-domain.com/functions/v1/razorpay-webhook` |
| Telegram | `https://api.apna-domain.com/functions/v1/telegram-bot` |

---

## Step 7 — Cron jobs

Cloud pe jo scheduled jobs the (`pg_cron`) unko phir se schedule karna hoga:

```bash
cd /opt/supabase
docker compose exec -T db psql -U postgres -c "SELECT * FROM cron.job;"
```

Agar khaali hai to migrations mein jo `cron.schedule(...)` calls hain woh dobara run karo.

---

## Important limitations

| Cheez | Transfer hota hai? |
|---|---|
| Tables, columns, indexes | ✅ Haan |
| RLS policies, DB functions, triggers | ✅ Haan (migrations se) |
| Table data (users, wallets, orders, transactions) | ✅ Haan (dump se) |
| `auth.users` + password hashes | ⚠️ Sirf agar dump mein `auth` schema included ho. Warna users ko password reset karna padega. |
| Storage bucket files (deposit-screenshots) | ❌ Manually copy karne padenge |
| Secrets / API keys | ❌ Manually re-enter (Step 5) |
| Lovable AI Gateway (`LOVABLE_API_KEY`) | ⚠️ Self-host pe kaam karega but usage Lovable account pe hi count hoga |

---

## Rollback

Kuch galat ho jaaye to Cloud backend chhua nahi gaya — woh waise hi chal raha hai.
Frontend `.env` purane Cloud values pe wapas karke rebuild karo, bas.

---

## Stack management commands

```bash
cd /opt/supabase
docker compose ps            # status
docker compose logs -f       # live logs
docker compose logs -f db    # sirf postgres
docker compose restart       # restart sab
docker compose down          # stop (data safe rehta hai)
```

Database backup (self-host pe allowed):

```bash
cd /opt/supabase
docker compose exec -T db pg_dump -U postgres postgres | gzip > /root/backup-$(date +%F).sql.gz
```
