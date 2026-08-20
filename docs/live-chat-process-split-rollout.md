# Live-Chat Process Split — Production Rollout

**Companion to:** [`live-chat-process-split-plan.md`](live-chat-process-split-plan.md)
**Applies to:** phases 0–5, which are merged and shipped dark
**Status:** ready to execute once the soak passes

---

## What this changes, in one line

`/ws/*` moves to its own single-worker process so the API can run four workers.

Everything needed is already in the repo and inert: `WS_BACKPLANE_ENABLED`
defaults to false, `oyechats-ws.service` is not installed, and nginx still sends
`/ws/` to the API on 127.0.0.1:8000 via its catch-all `location /`. Nothing in
production has changed yet. Verified on the box after the merge of PR #348:
backplane flag unset, `WEB_CONCURRENCY=1`, no WS unit, nothing on :8001.

**Measured payoff**, split topology on a 2 vCPU / 4 GB box:

| concurrent chats | today (1 worker) | after (4 API + 1 WS) |
|---:|---|---|
| 20 | 2.77 rps · 3,977 ms | **4.40 rps · 495 ms** |
| 30 | 3.13 rps · 8,511 ms · 3.2 % shed | **6.67 rps · 679 ms · 0 %** |
| 50 | 4.90 rps · 10,686 ms · **38.1 % shed** | **9.70 rps · 2,191 ms · 0 %** |

---

## Preconditions

1. **The soak passed.** Run the verdict tool over the sample CSV; every slope
   flat and both restart counters at zero. A soak that restarted a worker looks
   healthy afterwards *because the leak went with it*.
2. ~~**The widget's reconnect path is verified in a real browser.**~~ **DONE
   2026-08-18.** Built widget, real Chrome, live-chat socket held open against an
   idle rig node, then the serving process killed underneath it — twice.

   | Outage | What the widget did |
   |---|---|
   | `systemctl restart` (~7s) | close `1012`, retried at 1.22s, back open. Recovered in 6.9s. |
   | `stop`, 30s, `start` | close `1012`, then five refused attempts at **1.2s → 2.9s → 4.9s → 7.9s → 15.9s**, sixth succeeded. Recovered in 34.3s, about 4s after the port reopened. |

   The intervals match `min(1000 * 2^n, 30000)` with the ±10% jitter in
   `LiveChatMode.jsx`, and the attempt counter never approached its limit of 15.
   The session id survived both outages, the UI never stuck on a spinner or a
   dead "disconnected" state, and afterwards a normal question still round-tripped
   through the RAG path. Failed attempts close `1006`, which is the browser
   refusing a dead port, not the server rejecting anything.

   **What this means for the window:** sockets come back by themselves, but the
   backoff is what it is — a visitor whose retry lands just before the port
   reopens waits out the next interval, up to the 30s cap. Plan for visitors
   seeing up to ~30s of "reconnecting", not instant recovery.
3. **A maintenance window.** Short, but sockets do drop.
4. **`GUNICORN_BIND` is free on 127.0.0.1:8001.** The WS unit binds there; the
   API stays on 8000.

---

## Order of operations — this matters

Raising `WEB_CONCURRENCY` **before** `/ws/` is rerouted breaks live chat: a
visitor and their operator land on different workers and silently stop seeing
each other. Do these in order and verify each.

### 1. Enable the backplane on the API, still one worker

**Do not hand-edit `api/.env`.** `deploy-api.yml` rewrites that file in full on
every deploy, so an entry added on the box survives exactly until the next one.
The revert would be silent and badly timed: by then the API is running four
workers, and the backplane is what carries a frame from the worker that produced
it to the process holding the socket. Losing it means a visitor and their
operator stop seeing each other — the exact bug this split exists to prevent —
days after the deploy that caused it, with nothing in that deploy's diff to
point at.

Set the repo variable instead, which the workflow reads (defaulting to false):

```
gh variable set WS_BACKPLANE_ENABLED --body true
```

Then apply it. Either re-run the deploy, or set it on the box for now and let
the next deploy carry it:

```
grep -q '^WS_BACKPLANE_ENABLED=' /opt/oyechats/platform/api/.env \
  && sudo sed -i 's/^WS_BACKPLANE_ENABLED=.*/WS_BACKPLANE_ENABLED=true/' /opt/oyechats/platform/api/.env \
  || echo 'WS_BACKPLANE_ENABLED=true' | sudo tee -a /opt/oyechats/platform/api/.env
sudo systemctl restart oyechats-api
journalctl -u oyechats-api -n 50 | grep ws_backplane   # expect "subscriber listening"
```

The box edit alone is not enough — set the repo variable too, or the next deploy
takes it away.

Nothing about routing has changed yet — the API still serves sockets itself and
is still one worker. This step only proves the subscriber starts cleanly against
production Redis. **If it does not, stop here; nothing has changed.**

### 2. Install and start the WS process

```
sudo cp /opt/oyechats/platform/api/systemd/oyechats-ws.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oyechats-ws
systemctl is-active oyechats-ws
curl -fsS http://127.0.0.1:8001/health/live
```

It is running but receiving no traffic: nginx still routes `/ws/` to the API.

### 3. Point nginx at it

**Read this before editing.** The repo's `api/nginx/oyechats-api.conf` and
`oyechats-locations.conf` were never deployed — they describe an intended
configuration, not the running one. Production serves from a single
Certbot-managed file:

```
/etc/nginx/sites-available/oyechats-api      # symlinked from sites-enabled/oyechats-api (no .conf suffix)
```

It has **one** `location /` that proxies everything — `/ws/` included — to
`127.0.0.1:8000`, and there is **no `upstream oyechats_api`**. So do not add an
upstream or edit the snippet; add a `/ws/` location to the live file instead.

Back up first, since this file is hand/Certbot-managed and not in git:

```
sudo cp /etc/nginx/sites-available/oyechats-api /root/oyechats-api.nginx.$(date +%F).bak
```

Add inside the `server { ... }` block that listens on 443:

```
location /ws/ {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

Placement within the block is free: nginx selects the longest matching prefix,
so `/ws/` wins over `/` wherever it sits.

The timeout is not cosmetic. The live `location /` uses `proxy_read_timeout
300s`, which live chat survives today only because the app sends its own
heartbeat every 30s (`_HEARTBEAT_INTERVAL`, `app/api/ws_routes.py`). 86400s
removes that dependency rather than resting on it.

```
sudo nginx -t && sudo systemctl reload nginx
```

Reload by hand — the deploy workflow's reload is guarded on
`/etc/nginx/sites-enabled/oyechats-api.conf`, a path that does not exist (the
symlink carries no `.conf`), so deploys never reload nginx.

**Sockets drop here.** Verify with a real widget that live chat reconnects and a
message crosses in both directions before continuing.

```
journalctl -u oyechats-ws -f      # sockets should now arrive here
```

### 4. Only now, raise the API workers

```
# oyechats-api.service
Environment=WEB_CONCURRENCY=4
```
```
sudo systemctl daemon-reload && sudo systemctl restart oyechats-api
```

Check the boot log for the gate/pool warning added in Phase 5. If it fires,
`CHAT_MAX_CONCURRENCY` is at or above the per-worker pool ceiling — fix that
before leaving, or chat will drain the pool and gunicorn will start reaping
workers **while Postgres sits idle**, which reads like a database fault and
sends you to the wrong tier.

Default sizing is already correct: gate 10 < pool 5 + 10.

---

## Verify

- A real visitor→operator conversation, both directions, through the widget.
- An offline-message submission reaches a connected operator's console.
- An operator connect-request popup appears for the visitor.
- `journalctl -u oyechats-api | grep -c "WORKER TIMEOUT"` → **0**.
- Postgres connections stay inside the ceiling: 4 workers × 15 + worker 10 = 70
  against `max_connections=100`. Watch it for an hour.

---

## Rollback

No migration, no data change. Two edits:

```
# nginx: delete the /ws/ location block, or restore /root/oyechats-api.nginx.<date>.bak
#        (/ws/ then falls back to location / -> 127.0.0.1:8000, which carries the upgrade headers)
sudo nginx -t && sudo systemctl reload nginx

# oyechats-api.service
Environment=WEB_CONCURRENCY=1
sudo systemctl daemon-reload && sudo systemctl restart oyechats-api

sudo systemctl disable --now oyechats-ws   # optional
```

`WS_BACKPLANE_ENABLED` can stay true: with one worker every socket is local, so
the backplane never publishes and the code path is inert.

---

## Watch for a week

| signal | healthy | means |
|---|---|---|
| `WORKER TIMEOUT` count | 0 | requests exceeding gunicorn's 120s reaper |
| `chat_gate.rejected_total` | near 0 | load shedding |
| `pg_stat_activity` | < 70 | per-worker pools multiply |
| WS reconnect rate | flat | subscriber or socket churn |
| `oyechats-ws` restarts | 0 | each one drops every live conversation |

---

## Not included, deliberately

- **Multi-host.** One WS process is the design, not a half-built step toward
  many. Uploads still write local disk, which blocks multi-host but not
  multi-worker.
- **A distributed chat gate.** It stays per-process; four workers means four
  gates of ten. Sized deliberately, asserted at boot.
- **Splitting Postgres onto its own host.** Measured separately, worth ~2×, and
  independent of this work — bundling them would make a rollback ambiguous.
