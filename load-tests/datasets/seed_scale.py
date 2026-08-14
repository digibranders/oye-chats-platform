#!/usr/bin/env python
"""Bulk-seed chat_sessions + chat_messages for DATABASE SCALE testing (Phase 12).

Populates the two fastest-growing / hottest-queried tables to a target row count
so `EXPLAIN ANALYZE` on the real hot-path queries shows how they behave at
100K / 1M rows — and, crucially, before vs after adding the missing indexes
(ix_chat_messages_session_id, ix_chat_sessions_bot_id).

SAFETY: same "loadtest" DB-name guard as seed_fixtures.py. Never run on dev/prod.

Usage (from api/ with the venv, DB_URL = the isolated test DB):
    DB_URL=postgresql://localhost:5432/oyechats_loadtest \
      .venv/bin/python ../load-tests/datasets/seed_scale.py --messages 100000
    ... --messages 1000000
"""

from __future__ import annotations

import argparse
import os
import sys
import time

MSGS_PER_SESSION = 15


def _guard_db_url() -> str:
    db_url = os.getenv("DB_URL", "")
    if not db_url:
        sys.exit("DB_URL is not set.")
    if "loadtest" not in db_url and os.getenv("FORCE_SEED") != "1":
        sys.exit(f"Refusing: DB_URL ({db_url!r}) is not a load-test DB. Set FORCE_SEED=1 to override.")
    return db_url


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--messages", type=int, required=True, help="target chat_messages row count to add")
    ap.add_argument("--batch", type=int, default=5000)
    args = ap.parse_args()
    _guard_db_url()

    from sqlalchemy import text
    from app.db.session import engine

    if engine is None:
        sys.exit("engine is None — DB_URL not usable.")

    n_sessions = max(1, args.messages // MSGS_PER_SESSION)
    print(f"Seeding ~{n_sessions} sessions × {MSGS_PER_SESSION} = ~{args.messages} messages ...")

    t0 = time.time()
    with engine.begin() as conn:
        bot_id = conn.execute(text("SELECT id FROM bots ORDER BY id ASC LIMIT 1")).scalar()
        if bot_id is None:
            sys.exit("No bot found. Run seed_fixtures.py first.")

        # Sessions — spread created_at across the last 90 days for realistic sorts.
        sess_rows = []
        session_ids = []
        for i in range(n_sessions):
            sid = f"session_scale_{i}"
            session_ids.append(sid)
            sess_rows.append({"id": sid, "bot_id": bot_id, "offset_days": i % 90})
        for j in range(0, len(sess_rows), args.batch):
            chunk = sess_rows[j : j + args.batch]
            conn.execute(
                text(
                    "INSERT INTO chat_sessions (id, bot_id, status, created_at, last_active_at) "
                    "VALUES (:id, :bot_id, 'closed', now() - (:offset_days || ' days')::interval, now()) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                chunk,
            )
        print(f"  sessions inserted in {time.time()-t0:.1f}s")

        # Messages — MSGS_PER_SESSION per session, alternating user/bot.
        t1 = time.time()
        buf = []
        total = 0
        for sid in session_ids:
            for k in range(MSGS_PER_SESSION):
                role = "user" if k % 2 == 0 else "bot"
                buf.append(
                    {
                        "session_id": sid,
                        "role": role,
                        "content": f"scale message {k} for {sid}",
                        "offset_min": k,
                    }
                )
                if len(buf) >= args.batch:
                    conn.execute(
                        text(
                            "INSERT INTO chat_messages (session_id, role, content, created_at) "
                            "VALUES (:session_id, :role, :content, now() - (:offset_min || ' minutes')::interval)"
                        ),
                        buf,
                    )
                    total += len(buf)
                    buf = []
        if buf:
            conn.execute(
                text(
                    "INSERT INTO chat_messages (session_id, role, content, created_at) "
                    "VALUES (:session_id, :role, :content, now() - (:offset_min || ' minutes')::interval)"
                ),
                buf,
            )
            total += len(buf)
        print(f"  {total} messages inserted in {time.time()-t1:.1f}s")

    with engine.begin() as conn:
        conn.execute(text("ANALYZE chat_messages"))
        conn.execute(text("ANALYZE chat_sessions"))
    print(f"Done in {time.time()-t0:.1f}s. Ran ANALYZE.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
