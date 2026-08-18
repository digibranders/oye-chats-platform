# Live-Chat Process Split — Production Rollout

**Companion to:** [`live-chat-process-split-plan.md`](live-chat-process-split-plan.md)
**Applies to:** phases 0–5, which are merged and shipped dark
**Status:** ready to execute once the soak passes

---

## What this changes, in one line

`/ws/*` moves to its own single-worker process so the API can run four workers.

Everything needed is already in the repo and inert: `WS_BACKPLANE_ENABLED`
defaults to false, `oyechats-ws.service` is not installed, and nginx still sends
`/ws/` to the API upstream. Nothing in production has changed yet.

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
2. **The widget's reconnect path is verified in a real browser.** Step 3 restarts
   the WS process, which drops every open socket. Today a plain
   `systemctl restart` already does this mid-generation, so it is not a new
   failure mode — but it has never been done deliberately with sockets held.
3. **A maintenance window.** Short, but sockets do drop.
4. **`GUNICORN_BIND` is free on 127.0.0.1:8001.** The WS unit binds there; the
   API stays on 8000.

---

## Order of operations — this matters

Raising `WEB_CONCURRENCY` **before** `/ws/` is rerouted breaks live chat: a
visitor and their operator land on different workers and silently stop seeing
each other. Do these in order and verify each.

### 1. Enable the backplane on the API, still one worker

```
# in /opt/oyechats/platform/api/.env
WS_BACKPLANE_ENABLED=true
```
```
sudo systemctl restart oyechats-api
journalctl -u oyechats-api -n 50 | grep ws_backplane   # expect "subscriber listening"
```

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

Add the upstream beside `oyechats_api` in the server config:

```
upstream oyechats_ws { server 127.0.0.1:8001; }
```

The `location /ws/` block already targets `oyechats_ws` in
`nginx/oyechats-locations.conf`.

```
sudo nginx -t && sudo systemctl reload nginx
```

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
# nginx: location /ws/  ->  proxy_pass http://oyechats_api;
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
