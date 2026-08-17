#!/usr/bin/env python
"""Seed deterministic load-test FIXTURES into an ISOLATED test database.

Creates exactly what a chat load test needs and nothing customer-shaped:
  * 1 client (test admin) with a fixed api_key
  * 1 bot with a fixed bot_key
  * 1 active subscription (so the chat subscription-gate passes)
  * PricingConfig credit_cost.ai_chat = 0 (so chat needs no credit grants)
  * 1 operator
  * N documents with deterministic pseudo-embeddings (so hybrid retrieval runs)

SAFETY: refuses to run unless DB_URL points at a database whose name contains
"loadtest" (or FORCE_SEED=1 is set). NEVER run this against dev/prod data.

Usage (from api/ with the venv, DB_URL pointing at the test DB):
    DB_URL=postgresql://localhost:5432/oyechats_loadtest \
      .venv/bin/python ../load-tests/datasets/seed_fixtures.py --docs 50

Prints the bot_key / api_key / operator_key to stdout for the k6 env.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys

# Fixed, non-secret test credentials (safe to print; only valid in the test DB).
BOT_KEY = os.getenv("SEED_BOT_KEY", "bot-loadtest-000000")
API_KEY = os.getenv("SEED_API_KEY", "lt_admin_key_deterministic_0001")
OPERATOR_KEY = os.getenv("SEED_OPERATOR_KEY", "lt_operator_key_deterministic_0001")
CLIENT_EMAIL = os.getenv("SEED_CLIENT_EMAIL", "loadtest@example.invalid")
# Deterministic, NON-SECRET password for the seeded admin so scenarios can
# exercise POST /auth/login (the api_key alone cannot: login runs bcrypt against
# ``hashed_password``, which was previously never set, so every login attempt
# against a seeded fixture failed on a missing credential rather than on load).
# Same rationale as the deterministic api_key above — this value only ever
# exists in an isolated ``*loadtest*`` database, never in dev or production.
CLIENT_PASSWORD = os.getenv("SEED_CLIENT_PASSWORD", "LoadTest!Deterministic1")


def _guard_db_url() -> str:
    db_url = os.getenv("DB_URL", "")
    if not db_url:
        sys.exit("DB_URL is not set. Point it at the isolated test DB.")
    if "loadtest" not in db_url and os.getenv("FORCE_SEED") != "1":
        sys.exit(
            f"Refusing to seed: DB_URL ({db_url!r}) does not look like a load-test DB "
            "(name must contain 'loadtest', or set FORCE_SEED=1). Never seed dev/prod."
        )
    return db_url


def _pseudo_vector(seed_text: str, dim: int = 768) -> list[float]:
    h = int.from_bytes(hashlib.sha256(seed_text.encode()).digest(), "big")
    out = []
    for _ in range(dim):
        h = (h * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        out.append(((h >> 11) / float(1 << 53)) * 2.0 - 1.0)
    # L2 normalise (embeddings are compared by cosine).
    norm = sum(x * x for x in out) ** 0.5 or 1.0
    return [x / norm for x in out]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--docs", type=int, default=50, help="number of KB document chunks to seed")
    parser.add_argument(
        "--warm",
        type=int,
        default=120,
        help="number of 'warm' chat sessions (past name-ask onboarding) so each "
        "load-test VU drives the full RAG/LLM generation path, not the first-turn "
        "name-ask short-circuit. Must be >= max concurrency you plan to test.",
    )
    args = parser.parse_args()

    _guard_db_url()

    # Import AFTER the guard so app.config binds to the test DB_URL.
    from app.core.security import get_password_hash
    from app.db.models import (
        Bot,
        ChatSession,
        Client,
        Document,
        LeadInfo,
        Operator,
        Plan,
        PricingConfig,
        Subscription,
    )
    from app.db.session import SessionLocal

    if SessionLocal is None:
        sys.exit("SessionLocal is None — DB_URL not usable.")

    with SessionLocal() as db:
        # Client
        client = db.query(Client).filter(Client.api_key == API_KEY).one_or_none()
        if client is None:
            client = Client(name="LoadTest Admin", email=CLIENT_EMAIL, api_key=API_KEY, is_verified=True)
            db.add(client)
            db.flush()
        # Set on every run, not just on create, so databases seeded before this
        # existed also become login-capable without a re-seed from scratch.
        # Hashed via the app's own get_password_hash so the cost factor under test is
        # whatever production actually uses (bcrypt default rounds today).
        client.hashed_password = get_password_hash(CLIENT_PASSWORD)

        # Bot
        bot = db.query(Bot).filter(Bot.bot_key == BOT_KEY).one_or_none()
        if bot is None:
            bot = Bot(client_id=client.id, bot_key=BOT_KEY, name="LoadTest Bot")
            db.add(bot)
            db.flush()
        bot.indexed_chunk_count = args.docs  # >20 so CAG-lite doesn't skip retrieval
        bot.credits_balance = 10_000_000

        # Plan + active Subscription (chat subscription-gate must see active/trialing).
        #
        # Prefer an ENTITLED plan rather than simply the lowest id. Several
        # dashboard/analytics surfaces are plan-gated — the Journeys analytics
        # routes return 402 ("require a Standard or Professional plan") unless the
        # funding plan's slug is in ``JOURNEY_ANALYTICS_SLUGS``
        # (standard/professional/enterprise). Seeding the lowest-id plan meant
        # "free", so journey-analytics load runs measured a 402 rejection rather
        # than the analytics queries. ``standard`` is the cheapest entitled tier,
        # so it exercises the gated surfaces without over-provisioning.
        plan = (
            db.query(Plan).filter(Plan.slug == os.getenv("SEED_PLAN_SLUG", "standard")).one_or_none()
            or db.query(Plan).order_by(Plan.id.asc()).first()
        )
        if plan is None:
            sys.exit("No Plan rows found. Run scripts/seed_plans.py --apply against the test DB first.")
        sub = db.query(Subscription).filter(Subscription.client_id == client.id).one_or_none()
        if sub is None:
            sub = Subscription(client_id=client.id, plan_id=plan.id, status="active")
            db.add(sub)
            db.flush()
        else:
            sub.status = "active"
            # Move an existing fixture subscription onto the entitled plan too, so
            # re-seeding an older test DB fixes the gate without a rebuild.
            sub.plan_id = plan.id

        # Free chat: set the ai_chat credit cost to 0 so no credit grants needed.
        pc = db.get(PricingConfig, "credit_cost.ai_chat")
        if pc is None:
            db.add(PricingConfig(key="credit_cost.ai_chat", value=0))
        else:
            pc.value = 0

        # Operator
        op = db.query(Operator).filter(Operator.operator_api_key == OPERATOR_KEY).one_or_none()
        if op is None:
            op = Operator(
                client_id=client.id,
                bot_id=bot.id,
                name="LoadTest Operator",
                email="operator@example.invalid",
                operator_api_key=OPERATOR_KEY,
                role="owner",
            )
            db.add(op)

        # Documents with deterministic embeddings
        have = db.query(Document).filter(Document.bot_id == bot.id).count()
        for i in range(have, args.docs):
            text = f"Load-test knowledge chunk {i}. Pricing, trials, integration, API, export, support."
            db.add(
                Document(
                    bot_id=bot.id,
                    client_id=client.id,
                    document_name=f"loadtest-doc-{i}.txt",
                    source="upload",
                    file_hash=hashlib.sha256(f"{bot.id}:{i}".encode()).hexdigest(),
                    content=text,
                    embedding=_pseudo_vector(text),
                )
            )
        # Warm sessions: session_warm_0..N-1, each with a LeadInfo name so
        # resolve_visitor_name() returns a name -> the bot SKIPS the first-turn
        # name-ask and runs the full RAG + streaming LLM generation on every turn.
        # The knee scenario assigns one warm session per VU.
        existing_warm = {r[0] for r in db.query(ChatSession.id).filter(ChatSession.id.like("session_warm_%")).all()}
        for i in range(args.warm):
            sid = f"session_warm_{i}"
            if sid not in existing_warm:
                db.add(ChatSession(id=sid, bot_id=bot.id, status="bot"))
                db.flush()
                db.add(LeadInfo(session_id=sid, bot_id=bot.id, name=f"Warm Visitor {i}"))
        db.commit()

        print("SEED_OK")
        print(f"BOT_KEY={BOT_KEY}")
        print(f"API_KEY={API_KEY}")
        print(f"OPERATOR_KEY={OPERATOR_KEY}")
        print(f"CLIENT_EMAIL={CLIENT_EMAIL}")
        print(f"CLIENT_PASSWORD={CLIENT_PASSWORD}")
        print(f"client_id={client.id} bot_id={bot.id} plan_id={plan.id} docs={args.docs} warm_sessions={args.warm}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
