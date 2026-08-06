"""Local, isolated proof of the deactivate/reactivate knowledge behavior.

Creates a throwaway bot with two active chunks, then exercises the REAL
repository retrieval paths and the knowledge-state service:

  1. baseline           both chunks retrievable (keyword + vector + CAG-lite)
  2. deactivate         retrieval empty, count 0, dedup sees them as absent
  3. re-add on Free     a fresh active chunk is retrievable (not dedup-skipped)
  4. reactivate         old chunks come back (restore on re-upgrade)

Everything created is torn down at the end. Run from ``platform/api``:
    uv run python scripts/simulate_knowledge_deactivation.py
"""

from __future__ import annotations

import secrets

from sqlalchemy import text

from app.db import repository
from app.db.models import Bot, Client, Document
from app.db.session import get_session
from app.services.knowledge_state_service import deactivate_bot_knowledge, reactivate_bot_knowledge

_created_client_ids: list[int] = []
EMB = [0.1] * 768  # a fixed 768-dim embedding; querying with the same → distance 0


def _add_chunk(session, client_id: int, bot_id: int, name: str, content: str) -> None:
    doc = Document(
        client_id=client_id,
        bot_id=bot_id,
        document_name=name,
        source="upload",
        file_hash=secrets.token_hex(8),
        content=content,
        embedding=EMB,
        is_active=True,
    )
    session.add(doc)
    session.flush()
    # Populate the FTS vector the keyword search matches on.
    session.execute(
        text("UPDATE documents SET search_vector = to_tsvector('english', content) WHERE id = :id").bindparams(
            id=doc.id
        )
    )


def _retrieval_counts(session, client_id: int, bot_id: int) -> dict:
    kw = repository.search_keyword_documents(session, client_id=client_id, query="pricing refund policy", bot_id=bot_id)
    vec = repository.search_similar_documents(session, client_id=client_id, query_embedding=EMB, bot_id=bot_id)
    cag = repository.count_documents_for_bot(session, bot_id=bot_id, client_id=client_id)
    listed = repository.get_ingested_documents(session, client_id=client_id, bot_id=bot_id)
    return {"keyword": len(kw), "vector": len(vec), "cag_count": cag, "kb_list": len(listed)}


def _teardown(session) -> None:
    if not _created_client_ids:
        return
    ids = ", ".join(str(int(i)) for i in _created_client_ids)
    for table in ("documents", "bots"):
        session.execute(text(f"DELETE FROM {table} WHERE client_id IN ({ids})"))
    session.execute(text(f"DELETE FROM clients WHERE id IN ({ids})"))
    session.commit()
    print(f"\nTeardown: removed {len(_created_client_ids)} throwaway client(s) and all their rows.")


def main() -> None:
    with get_session() as session:
        client = Client(
            name="Sim KB",
            email=f"sim.kb.{secrets.token_hex(3)}@example.com",
            api_key="sk_sim_" + secrets.token_hex(10),
            is_verified=True,
        )
        session.add(client)
        session.flush()
        _created_client_ids.append(client.id)
        bot = Bot(client_id=client.id, name="Sim KB Bot", bot_key="bot-simkb-" + secrets.token_hex(5))
        session.add(bot)
        session.flush()

        try:
            _add_chunk(session, client.id, bot.id, "pricing.pdf", "Our pricing includes a full refund policy.")
            _add_chunk(session, client.id, bot.id, "hours.pdf", "Support hours are 9 to 5, refund requests honored.")
            session.commit()

            print("1) BASELINE (paid, both chunks active)")
            print("   ", _retrieval_counts(session, client.id, bot.id))

            print("\n2) DOWNGRADE → deactivate_bot_knowledge")
            n = deactivate_bot_knowledge(session, bot.id)
            session.commit()
            print(f"    deactivated {n} chunk(s)")
            print("   ", _retrieval_counts(session, client.id, bot.id), "  <- retrieval now empty")
            # A downgraded chunk's hash is treated as absent, so a Free re-crawl/
            # re-upload is NOT skipped as a duplicate.
            old_hash = session.execute(
                text("SELECT file_hash FROM documents WHERE bot_id = :b LIMIT 1").bindparams(b=bot.id)
            ).scalar_one()
            seen = repository.is_document_processed(session, client_id=client.id, file_hash=old_hash, bot_id=bot.id)
            print(f"    dedup sees the old (deactivated) hash as present? {seen}  <- False = re-add allowed")

            print("\n3) RE-ADD ON FREE (a fresh active chunk)")
            _add_chunk(session, client.id, bot.id, "free-note.txt", "Free plan note: refund within 7 days.")
            session.commit()
            print("   ", _retrieval_counts(session, client.id, bot.id), "  <- only the newly re-added chunk")

            print("\n4) RE-UPGRADE → reactivate_bot_knowledge")
            n = reactivate_bot_knowledge(session, bot.id)
            session.commit()
            print(f"    reactivated {n} chunk(s)")
            print(
                "   ", _retrieval_counts(session, client.id, bot.id), "  <- old knowledge restored + the re-added one"
            )

            active = session.execute(
                text("SELECT count(*) FROM documents WHERE bot_id = :b AND is_active").bindparams(b=bot.id)
            ).scalar_one()
            total = session.execute(
                text("SELECT count(*) FROM documents WHERE bot_id = :b").bindparams(b=bot.id)
            ).scalar_one()
            print(f"\n    Final: {active}/{total} chunks active. Nothing was ever deleted ({total} rows intact).")
        finally:
            _teardown(session)


if __name__ == "__main__":
    main()
