# Sentry DSN repair — silent error-tracking outage since project deploy

**Date:** 2026-04-27 · **Operator:** infra · **Severity:** P1 (silent — no user-visible impact, but observability gap was total)

## What was wrong

The `SENTRY_DSN_BACKEND` secret in GitHub Actions (and therefore in the live `.env` regenerated on every deploy) was **truncated by 2 characters** at the project-id segment:

| Where | Project ID at end of DSN |
|---|---|
| Live env (broken) | `45111039872860` (14 digits) |
| Sentry's actual DSN for `oyechat-fastapi-backend` | `4511103987286016` (16 digits) |

The trailing **`16`** was missing. The Sentry ingest endpoint accepted the events (the org id `o4511098086227968` and auth key were valid), but the project id didn't resolve to any project, so events landed in a black hole.

## How it was diagnosed

1. Audit found `SENTRY_DSN_BACKEND` set, `SENTRY_ENABLED=True`, init log present, FastAPI / Redis / threading integrations loaded — all signs of a working setup.
2. Issue feed in Sentry org `fynix-digital` showed **0 issues over 14 days** for the only two visible projects.
3. Test events sent via SDK from the production process returned valid `event_id`s (Sentry accepted them) but the events did not appear in any project.
4. Comparing the DSN's project id (`45111039872860`) to the URL-bar `?project=…` value of the actual `oyechat-fastapi-backend` project (`4511103987286016`) revealed the truncation.
5. `Settings → Projects → oyechat-fastapi-backend → Client Keys (DSN)` showed the canonical DSN with `4511103987286016`. Confirmed.

## Impact

**Every error, exception, performance trace, and log emitted by the API or worker since the Sentry integration shipped never reached Sentry.** The dashboard and alert rules were dormant. Specifically affected:

- The pre-existing LiteLLM `gpt-5 temperature=0` error this morning at 05:25 UTC — invisible.
- The Redis quota crash loop (540 worker restarts) — invisible.
- Every 503 from `/health` while Redis was dead — invisible.

No user-visible regression because the app didn't depend on Sentry being alive. But monitoring was a no-op.

## Fix

```bash
# 1. Update GH Actions secret so all future deploys write the correct DSN
gh secret set SENTRY_DSN_BACKEND --body 'https://<key>@o4511098086227968.ingest.us.sentry.io/4511103987286016' \
  --repo digibranders/oye-chats-platform

# 2. Patch the live .env so the running services pick it up immediately
ssh root@<droplet-ip>
cp /opt/oyechats/platform/api/.env /opt/oyechats/platform/api/.env.bak.before-sentry-fix.<ts>
sed -i 's|^SENTRY_DSN_BACKEND=.*|SENTRY_DSN_BACKEND=<correct DSN>|' /opt/oyechats/platform/api/.env
systemctl restart oyechats-api oyechats-worker
```

## Verification

Sent two test events from the production Python process via `sentry_sdk.capture_message` and `capture_exception`. Both appeared in `oyechat-fastapi-backend` Sentry project within ~10 seconds:

- `RuntimeError` issue `OYECHAT-FASTAPI-BACKEND-2`
- Info message issue `OYECHAT-FASTAPI-BACKEND-1`

Both tagged `service: api`, `release: sentry-fix-verification`, `environment: production`.

## Follow-ups

- ☐ Set up a Sentry alert rule: "more than 10 events in 5 min" → email. (Free tier supports this.)
- ☐ Verify the `release` tag set by `9022bdb` flows through after the next deploy from `main`.
- ☐ Confirm the worker also captures (worker init was added in `9022bdb`); will appear naturally on the next background-task error.

## How this could have been caught earlier

- A deploy-time smoke test that calls `sentry_sdk.capture_message("post-deploy smoke")` and then verifies the event id via Sentry's REST API.
- A weekly "Sentry should have ≥1 transaction in the last 24h" health check (the 0-events-for-14-days signal would have surfaced this immediately).
- Any time the DSN was set/rotated, paste-time validation: count digits in the final segment (Sentry project ids are always 16 digits in current accounts).
