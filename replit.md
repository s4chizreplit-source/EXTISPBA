# OrganicSMM Pro

Full SMM panel — React + Vite frontend, Node.js + Express API, PostgreSQL, deployed on a VPS behind Caddy.

## Repo layout

```
src/                    React + Vite frontend (SPA, built to dist/)
server/                 Express API (self-hosted, VPS only)
  src/index.js          entry — listens on PORT (3000)
  src/db.js             pg pool + transaction helper
  src/migrate.js        SQL migration runner
  src/provider.js       reseller/provider API client (SMM API v2 shape)
  src/routes/           auth, wallet, services, orders, admin
  migrations/*.sql      schema + starter service catalog
deploy/hostinger-setup.sh   one-shot VPS installer
deploy/update.sh            one-command updater
```

## Environment variables (`/etc/smmpanel.env`)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql://user:pass@127.0.0.1:5432/smmpanel` |
| `SESSION_SECRET` | random 64-char string signing session cookies |
| `PORT` | `3000` (Caddy reverse-proxies to this) |
| `PROVIDER_API_KEY` | reseller panel API key |
| `PROVIDER_API_URL` | e.g. `https://provider.com/api/v2` |
| `PUBLIC_APP_URL` | `https://your-domain.com` (used in reset links) |

If the provider vars are empty the API runs in **simulate mode** — orders are accepted and wallets debited, but nothing is sent to a provider. Handy for testing.

## First deploy (Hostinger VPS, Ubuntu 22.04/24.04)

```bash
curl -fsSL https://raw.githubusercontent.com/USERNAME/REPO/main/deploy/hostinger-setup.sh | bash
```

Non-interactive variant (recommended when piping):

```bash
curl -fsSL https://raw.githubusercontent.com/USERNAME/REPO/main/deploy/hostinger-setup.sh \
  | REPO_URL=https://github.com/USERNAME/REPO.git DOMAIN=panel.example.com bash
```

The installer:
1. Installs Node.js 20, pnpm 9, PostgreSQL, Caddy, ufw.
2. Creates the `smmpanel` database + role with a random password.
3. Clones the repo into `/opt/smmpanel`.
4. Writes secrets to `/etc/smmpanel.env` (`chmod 640`, never overwritten if it exists).
5. `pnpm install` + `pnpm run build`, then runs SQL migrations.
6. Creates and starts the `smmpanel` systemd service (auto-restart, hardened).
7. Configures Caddy for your domain with automatic HTTPS, opens 80/443.
8. Health-checks `http://127.0.0.1:3000/healthz`.

**The first account you sign up with becomes the admin.**

## Updating

```bash
bash /opt/smmpanel/deploy/update.sh
```

Pulls `main`, installs new deps, runs pending migrations, restarts the service, and **auto-rolls back** to the previous commit if the health check fails.

## Operations

```bash
systemctl status smmpanel        # service state
journalctl -u smmpanel -f        # live logs
systemctl restart smmpanel       # apply env changes
node server/src/migrate.js       # run migrations manually
sudo -u postgres psql smmpanel   # DB shell
```

## Local development

```bash
pnpm install
cp server/.env.example server/.env    # point DATABASE_URL at a local Postgres
pnpm --filter @organicsmm/server run migrate
pnpm --filter @organicsmm/server run dev   # API on :3000
pnpm run dev                              # Vite dev server (proxy /api to :3000)
```

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/signup` | first user becomes admin |
| POST | `/api/auth/login` / `/logout` | session cookie |
| GET | `/api/auth/me` | current user |
| POST | `/api/auth/forgot-password` | issues 1h reset token (logged; wire your mailer) |
| POST | `/api/auth/reset-password` | consumes token |
| GET | `/api/wallet` · `/api/wallet/transactions` | balance + ledger |
| GET | `/api/services` | catalog, filter by `platform`/`search` |
| POST | `/api/orders/quote` | price preview |
| POST | `/api/orders` | debit wallet + dispatch to provider (auto-refund on failure) |
| GET | `/api/orders` · `/api/orders/:id` | history + live status refresh |
| GET | `/api/admin/stats` · `/users` · `/services` · `/orders` | admin panel data |
| POST | `/api/admin/users/:id/balance` | manual add/subtract balance |
| PATCH | `/api/admin/users/:id` · `/services/:id` · `/orders/:id` | manage records |
| GET | `/healthz` | used by deploy scripts |

## Money safety

- Wallet debit, order insert, and the ledger row happen in **one transaction** with `SELECT ... FOR UPDATE` on the wallet.
- Provider dispatch happens **after** commit; a provider rejection auto-refunds under a status guard so a retry can't double-refund.
- `transactions.reference` is uniquely indexed — replayed credits/refunds are no-ops.
