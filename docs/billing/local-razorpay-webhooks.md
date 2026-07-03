# Local Razorpay webhook testing (ngrok tunnel)

Razorpay webhooks (`subscription.activated`, `subscription.charged`,
`payment.captured`, `order.paid`, `refund.*`, `payment.dispute.*`) drive the
credit grants, plan flips, and invoice creation. They can't reach
`localhost:8000`, so on a dev box those flows depend entirely on the synchronous
`/verify` fallbacks — one hiccup (server reload, network blip) and a paid
transaction lands with no grant/invoice. A tunnel makes local testing match prod.

## Daily use — one command

```bash
cd api && ./scripts/dev.sh
```

[`api/scripts/dev.sh`](../../api/scripts/dev.sh) runs the whole backend stack so
the tunnel is always up alongside the dev server:

1. `alembic upgrade head` (a stale dev DB silently breaks invoice writes — see Gotchas)
2. ngrok tunnel on the account's **static domain** `nuclei-rundown-okay.ngrok-free.dev`
3. ARQ worker (invoice PDFs, emails, sweeps)
4. uvicorn on :8000 with reload

Ctrl+C stops all of them. ngrok output goes to `api/.ngrok.log`; the request
inspector is at `http://127.0.0.1:4040`.

Because the domain is static, the Razorpay dashboard registration is **one-time**
and never needs updating.

## One-time setup

1. **Install + auth ngrok** (already done on this machine)
   ```bash
   brew install ngrok
   ngrok config add-authtoken <token-from-ngrok.com>
   ```

2. **Register the webhook in the Razorpay dashboard**
   (Settings → Webhooks → Add New Webhook)
   - **URL:** `https://nuclei-rundown-okay.ngrok-free.dev/webhooks/razorpay`
   - **Secret:** must equal `RAZORPAY_WEBHOOK_SECRET` in `api/.env`
   - **Active events:** `subscription.activated`, `subscription.charged`,
     `subscription.cancelled`, `subscription.completed`, `subscription.halted`,
     `subscription.pending`, `payment.captured`, `payment.failed`, `order.paid`,
     `refund.created`, `refund.processed`, `refund.failed`,
     `payment.dispute.created`, `payment.dispute.lost`, `payment.dispute.won`

Verified 2026-07-03: `GET /health` returns 200 through the tunnel, and
`POST /webhooks/razorpay` with a bad signature returns 400 (signature check
working end-to-end).

## Fallback: cloudflared (automatic)

If ngrok fails to establish (auth problem, account limit, ngrok outage),
`dev.sh` detects it (polls ngrok's local API on :4040 for up to 15s) and
automatically falls back to a **cloudflared quick tunnel**:

```bash
cloudflared tunnel --url http://127.0.0.1:8000   # what dev.sh runs for you
```

- Requires `brew install cloudflared` (already installed on this machine).
- No account/auth needed for quick tunnels.
- **The `*.trycloudflare.com` URL rotates every run** — the script prints the
  new webhook URL and you must paste it into the Razorpay dashboard for that
  session. This is why ngrok's static domain is the primary.
- Verified 2026-07-03: health 200 + webhook signature-reject 400 through a
  quick tunnel.

If a permanently stable non-ngrok URL is ever needed, the durable option is a
**named Cloudflare tunnel** on a domain already in the Cloudflare account
(e.g. `dev-webhooks.oyechats.com`): `cloudflared tunnel login` →
`cloudflared tunnel create oyechats-dev` → DNS route + config. One-time
interactive setup; then it's static like ngrok's domain.

## Gotchas

- **Run `alembic upgrade head` after pulling billing changes.** The dev DB
  (`oyechats`) must be at the current head or invoice ORM operations fail with
  `column ... does not exist` (this is exactly what broke the top-up grant on
  2026-07-03 — the DB was one migration behind on `emailed_at`).
- The worker must run for invoice PDFs to render (`pdf_url` stays null otherwise;
  the invoice row + tax breakup still show in the UI).
- With the tunnel up, the `/verify` fallbacks and the webhook both run — they're
  idempotent (keyed on payment id / a reconcile marker), so no double-grant.
