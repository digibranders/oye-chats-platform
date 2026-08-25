# Multilingual rollback runbook

Phase 6. What to reach for, in what order, when multilingual misbehaves in
production.

The levers are ordered by **blast radius and speed**, fastest and narrowest
first. Start at the top and stop as soon as the symptom clears. Reaching
straight for a backend rollback because it feels decisive is almost always the
wrong move: it is the slowest lever and the only one that can drop live
connections.

---

## The one thing to know first

**A widget rollback is NOT a multilingual rollback.**

The widget and the backend hold two halves of this feature. Rolling the widget
back reverts the visitor's *interface*: the language selector, the localized
chrome, the RTL direction flip. It does not touch the *conversation*. The
backend keeps resolving a session language and keeps answering in it.

The result is a mixed state that is worse than either side alone: a visitor
sees an English interface and receives Hindi answers inside it. If the problem
is "the AI is answering in the wrong language", rolling the widget back changes
nothing about the cause and makes the symptom harder to read.

Use the widget rollback for widget bugs. Use the switches for conversation
behaviour.

---

## Lever order

| # | Lever | Scope | Time to effect | Drops connections |
|---|---|---|---|---|
| 1 | `feature.translation_enabled` = false | Platform, operator translation only | ~60 s | No |
| 2 | `feature.multilingual_chat_enabled` = false | Platform, all language behaviour | ~60 s | No |
| 3 | Per-bot `language_config.enabled` = false | One bot | Immediate | No |
| 4 | Widget manifest rollback | All widgets, interface only | ~1 min | No |
| 5 | Backend rollback (revert + redeploy) | Everything | ~10 min | Yes (WS restart) |

### 1. Translation kill switch

Super-admin pricing panel, `feature.translation_enabled` to `false`.

Stops every operator-translation call platform-wide. Live chat continues in the
original languages: the visitor sees the operator's actual words, the operator
sees the visitor's. Nothing is charged. No conversation is interrupted and no
socket is dropped.

Propagation is up to 60 seconds (`_PRICING_CACHE_TTL_SECONDS`), per process.

**Reach for this when:** translations are wrong, slow, or expensive, but
conversations are otherwise fine.

### 2. Multilingual kill switch

Super-admin pricing panel, `feature.multilingual_chat_enabled` to `false`.

Stops visitor language resolution and the AI's answer-language behaviour for
every bot. Each bot behaves exactly as one whose owner never enabled
multilingual: no language directive in the prompt, the legacy QA cache key,
English canned paths. `GET /bots/settings/public` also reports
`language_config.enabled: false`, so widgets stop offering the language
selector rather than offering one the backend will ignore.

Stored per-bot configuration is **not** modified. Switching back restores
exactly what each customer configured.

Same ~60 second propagation. Also implies lever 1: with no session language,
there is nothing to translate.

**Reach for this when:** language resolution or answer language is wrong across
many bots.

**Note:** conversations already in flight switch to the bot's default language
mid-thread. A visitor mid-way through a Hindi conversation will see the next
answer in English. That is the intended behaviour of a kill switch, but it is
visible, so prefer lever 3 if the problem is one bot.

### 3. Per-bot disable

Admin, or `UPDATE bots SET language_config = jsonb_set(language_config,
'{enabled}', 'false') WHERE id = ?;`

Narrowest lever. Same mid-conversation switch as lever 2, but for one customer.

**Reach for this when:** one bot is misconfigured, one customer is affected, or
you are containing a blast radius while investigating.

### 4. Widget manifest rollback

The widget's cache layout makes this fast and safe, and it is worth
understanding before you need it:

```
dist/oyechats-widget.js      loader IIFE     MUTABLE    purged on deploy
dist/app/manifest.json       chunk manifest  MUTABLE    purged on deploy
dist/app/oyechats-*.js|css   hashed chunks   IMMUTABLE  1 year, never purged
```

Because chunks are content-hashed and immutable, **every previously deployed
chunk is still on the CDN**. The manifest is the only thing that decides which
of them a browser loads. Rolling back is therefore: put the previous
`manifest.json` back and purge it.

```bash
# 1. Recover the previous manifest from the deploy you want to return to.
#    Every deploy uploads it, so the artifact is whatever that commit built.
git checkout <previous-sha> -- widget/
cd widget && npm ci && npm run build

# 2. Upload the manifest ALONE. Do not touch the chunks: the ones this
#    manifest references are already on the CDN and are immutable.
bash scripts/r2-put.sh \
  "<R2_BUCKET>/app/manifest.json" dist/app/manifest.json \
  --content-type=application/json \
  --cache-control='no-cache, must-revalidate, s-maxage=300'   # same header the deploy sets

# 3. Purge the manifest and the loader. The loader hard-codes the manifest URL,
#    so a stale loader is harmless, but purging both keeps the flip atomic.
#    (Cloudflare cache purge for /app/manifest.json and /oyechats-widget.js)
#    The purge is not optional: s-maxage=300 lets Cloudflare keep serving the
#    manifest you just replaced for up to five more minutes without it.
```

Clients pick up the change on their next page load. No deploy, no CI cycle.

**Reach for this when:** the widget bundle itself is broken (a render bug, a
chunk that fails to load, a localization regression in the chrome).

**Do not reach for this when:** the AI is answering in the wrong language, the
operator sees untranslated text, or translation is failing. None of those live
in the widget. See levers 1 to 3.

### 5. Backend rollback

Revert the merge on `main` and let `deploy-api.yml` run, or use the workflow's
automatic rollback (it triggers on a failed health check and restores the
previous SHA on its own).

Slowest lever, ~10 minutes for a full CI cycle, and the only one that restarts
`oyechats-ws` and therefore **drops every open WebSocket**. Visitors and
operators reconnect (the widget backs off and re-fetches history), but live
chats visibly blip.

**Reach for this when:** the switches cannot express the problem, for example a
crash, a data-correctness bug, or a regression in code the switches do not gate.

---

## Data safety

Every lever above is non-destructive:

- Message originals are never overwritten. `ChatMessage.content` is the
  canonical text; translations live in a separate JSONB keyed by language.
- Every language column is nullable and every language config key has a
  default, so code that predates them reads them as absent, not as an error.
- The switches read configuration at request time. Nothing is migrated,
  backfilled, or rewritten when one is flipped.
- `alembic downgrade` drops the added columns cleanly. The `credit_reason`
  enum keeps its `translation` label, because PostgreSQL cannot drop an enum
  value and an unused label is harmless.

Nothing in this list strands data, so any lever can be reversed by putting it
back.

---

## After any rollback

1. Confirm which processes actually restarted. `oyechats-api`,
   `oyechats-worker` **and** `oyechats-ws` must all show a start time after the
   deploy: `systemctl show <unit> -p ActiveEnterTimestamp --value`.
   The WebSocket service was historically missed by the deploy, so it is the
   one to check first.
2. Confirm the deployed commit: `cd /opt/oyechats/platform && git log --oneline -1`.
3. Confirm health: `curl -sf localhost:8000/health/full`.
4. Check the translation counters recovered:
   `translation_ok` rising, `translation_provider_failed` and
   `translation_gated` flat.
