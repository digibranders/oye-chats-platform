# Auto-Detect Contact URL From The Knowledge Base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a bot's contact page automatically from the pages it has already crawled, so the pricing gate can escalate a Free bot to a real contact link without the admin ever configuring a Smart Link.

**Architecture:** A pure detection module scans the distinct source URLs a bot already stores in `documents` and picks the one whose path is a contact page. The result is stamped onto a new nullable `bots.derived_contact_url` column by `sync_bot_knowledge_state`, which already runs after every knowledge mutation (crawl, upload, delete). The chat hot path then reads that column instead of running a query. An admin-configured `contact` Smart Link still wins: explicit beats inferred.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, pytest, `uv`, Postgres 16.

---

## Why a stamped column and not a query at request time

Measured on the local database, the "distinct source URLs for one bot" query costs:

| Bot | Distinct sources | Median query time |
|---|---|---|
| 13 (`mega bot`, CleanStart) | 512 | **12.3 ms** |
| 29 (`Chatbot`) | 14 | 0.2 ms |

12 ms per pricing turn, on the chat hot path, growing with knowledge-base size, for a value that only changes when the knowledge base changes. That is exactly what a derived stamp is for. `Bot.indexed_chunk_count` and `Bot.crawl_completed_at` already work this way, and `scripts/backfill_bot_knowledge_state.py` is the established backfill precedent.

## Scope

**In scope:** contact-page detection only.

**Deliberately NOT in scope:** auto-detecting `pricing_url`. The pricing gate's whole promise is "answer only from the page the OWNER NAMED". Auto-selecting a pricing page would let the bot quote from a page the owner never sanctioned (an old `/plans` page, a regional price list). Task 7 adds a *warning* for a mis-set `pricing_url`, which surfaces the problem without changing any answer. Auto-substitution is a separate product decision, recorded in "Open Decisions" below.

## File Structure

| File | Responsibility |
|---|---|
| `api/app/services/knowledge_links.py` | **Create.** Pure detection: given source URLs, return the contact page. No DB, no I/O. |
| `api/tests/test_knowledge_links.py` | **Create.** Unit tests for detection. |
| `api/app/db/models.py` | **Modify.** Add `Bot.derived_contact_url`. |
| `api/alembic/versions/b1000004contact_add_bot_derived_contact_url.py` | **Create.** The migration. |
| `api/app/db/repository.py` | **Modify.** `sync_bot_knowledge_state` stamps the derived URL. |
| `api/app/services/rag_service.py` | **Modify.** `resolve_contact_url(bot)` with precedence; wire into both pipelines. |
| `api/tests/test_pricing_gate_contact_fallback.py` | **Create.** Precedence + end-to-end gate behaviour. |
| `api/scripts/backfill_bot_derived_contact_url.py` | **Create.** Stamp existing bots. |

---

## Task 1: Pure contact-page detection

**Files:**
- Create: `api/app/services/knowledge_links.py`
- Test: `api/tests/test_knowledge_links.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_knowledge_links.py`:

```python
"""Contact-page detection from a bot's own crawled source URLs."""

from __future__ import annotations

from app.services.knowledge_links import detect_contact_url


class TestDetectContactUrl:
    # NOTE: Tasks 3 and 7 extend this file's import block at the top rather than
    # appending imports, because ruff enforces E402 in this repo.
    def test_finds_a_contact_us_page(self):
        urls = [
            "https://www.cleanstart.com/",
            "https://www.cleanstart.com/about-us",
            "https://www.cleanstart.com/contact-us",
        ]
        assert detect_contact_url(urls) == "https://www.cleanstart.com/contact-us"

    def test_finds_a_bare_contact_page(self):
        assert detect_contact_url(["https://fynix.digital/contact"]) == "https://fynix.digital/contact"

    def test_returns_none_when_no_contact_page(self):
        urls = ["https://x.com/", "https://x.com/blogs", "https://x.com/about"]
        assert detect_contact_url(urls) is None

    def test_a_deep_page_merely_mentioning_contact_does_not_match(self):
        """Only a page whose WHOLE path is a contact slug counts. A blog post
        about contacting support is not the company's contact page."""
        urls = ["https://x.com/blogs/how-to-contact-support", "https://x.com/blog/contact-us-tips"]
        assert detect_contact_url(urls) is None

    def test_ignores_unusable_urls(self):
        """Anything ``normalize_url`` rejects can never reach a visitor's reply."""
        assert detect_contact_url(["javascript:alert(1)", "mailto:a@b.com", "/contact"]) is None

    def test_ignores_junk_entries(self):
        assert detect_contact_url([None, 123, {}, "https://x.com/contact"]) == "https://x.com/contact"

    def test_is_deterministic_when_several_match(self):
        """Two contact-ish pages must always resolve to the same one, so a
        recrawl cannot silently swap the link a visitor is handed."""
        urls = ["https://x.com/contact-us", "https://x.com/contact"]
        assert detect_contact_url(urls) == detect_contact_url(list(reversed(urls)))
        assert detect_contact_url(urls) == "https://x.com/contact"  # shortest path wins

    def test_returns_the_url_as_stored_not_normalized(self):
        """The visitor needs a clickable link, not the comparison form."""
        assert detect_contact_url(["https://www.x.com/contact/"]) == "https://www.x.com/contact/"

    def test_empty_input(self):
        assert detect_contact_url([]) is None
        assert detect_contact_url(None) is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -v --no-cov
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.knowledge_links'`

- [ ] **Step 3: Write the implementation**

Create `api/app/services/knowledge_links.py`:

```python
"""Derive useful links from a bot's own knowledge base.

The platform already knows a customer's contact page: the crawler stored it as
a row in ``documents`` the first time it walked their site. Until now the only
way for the bot to USE that page was for an admin to re-type it as a ``contact``
Smart Link, and in practice nobody does (0 of 18 bots on the local database had
one). The Free pricing pivot, whose whole job is to hand over that page, was
therefore dead code, and every Free bot fell through to answering pricing
questions from its unrestricted knowledge base.

This module closes that gap by reading what the crawl already found.

Pure by design: no DB, no I/O, no import from ``rag_service``. Callers pass the
source URLs they have already loaded and act on the answer.

MATCHING IS DELIBERATELY NARROW. A page qualifies only when its ENTIRE path is
one of the contact slugs below (``/contact``, ``/contact-us``), never when a
slug merely appears somewhere in a longer path. ``/blogs/how-to-contact-support``
is an article about contacting someone, not the company's contact page, and
handing a visitor a blog post when they wanted a human is worse than handing
them nothing. Widening this later is cheap; a wrong link shipped to visitors is
not.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.services.pricing_gate import normalize_url

#: A page qualifies when its whole path equals one of these, case-insensitively.
#: Kept as exact slugs rather than a regex so adding one is a one-line review.
CONTACT_SLUGS: frozenset[str] = frozenset(
    {
        "contact",
        "contact-us",
        "contact_us",
        "contactus",
        "contact-me",
        "get-in-touch",
        "getintouch",
        "reach-us",
        "talk-to-us",
    }
)


def _path_of(normalized: str) -> str:
    """The path portion of a normalized URL, without leading/trailing slashes.

    ``normalize_url`` has already dropped the scheme, ``www.``, query and
    fragment, so what remains is ``host/path``. Splitting on the first ``/``
    leaves the path, and an empty string for a bare domain.
    """
    _, _, path = normalized.partition("/")
    return path.strip("/").casefold()


def detect_contact_url(source_urls: Iterable[object] | None) -> str | None:
    """Pick the contact page out of a bot's crawled source URLs.

    ``source_urls`` is whatever the caller has: typically the distinct
    ``documents.document_name`` values for one bot. Junk entries (``None``,
    non-strings, uploaded filenames, anything ``normalize_url`` rejects) are
    skipped rather than raised on, because this column is populated from
    real customer crawls and one bad row must not break ingestion.

    Returns the URL AS STORED (trimmed), not the normalized form: the visitor
    is handed this string as a clickable link, and ``normalize_url`` strips the
    scheme for comparison purposes only. This mirrors
    ``rag_service._contact_url_from_answer_links``.

    When several pages qualify the SHORTEST path wins, ties broken
    lexicographically. Determinism matters more than which one is "best": the
    value is re-derived on every recrawl, and a non-deterministic pick would
    silently swap the link a visitor is handed between two crawls of an
    unchanged site.
    """
    if not source_urls:
        return None

    candidates: list[tuple[int, str, str]] = []
    for raw in source_urls:
        if not isinstance(raw, str):
            continue
        candidate = raw.strip()
        normalized = normalize_url(candidate)
        if normalized is None:
            continue
        path = _path_of(normalized)
        if path in CONTACT_SLUGS:
            candidates.append((len(path), path, candidate))

    if not candidates:
        return None
    candidates.sort()
    return candidates[0][2]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -v --no-cov
```

Expected: PASS (9 tests)

- [ ] **Step 5: Lint, format, commit**

```bash
cd api && uv run ruff check app/services/knowledge_links.py tests/test_knowledge_links.py && uv run ruff format app/services/knowledge_links.py tests/test_knowledge_links.py
git add api/app/services/knowledge_links.py api/tests/test_knowledge_links.py
git commit -m "feat: detect a bot's contact page from its crawled source URLs"
```

---

## Task 2: Add the `bots.derived_contact_url` column

**Files:**
- Modify: `api/app/db/models.py` (the `Bot` class, beside `answer_links`)
- Create: `api/alembic/versions/b1000004contact_add_bot_derived_contact_url.py`

- [ ] **Step 1: Add the column to the model**

In `api/app/db/models.py`, find `answer_links = Column(JSONB, nullable=True)` (line ~575) and add immediately below it:

```python
    # The contact page DERIVED from this bot's own crawled pages, stamped by
    # ``repository.sync_bot_knowledge_state`` after every knowledge mutation.
    # Read only as a FALLBACK: an admin-configured ``contact`` Smart Link in
    # ``answer_links`` always wins, because explicit configuration must beat
    # inference. NULL means the crawl found no page whose whole path is a
    # contact slug (see ``services/knowledge_links.CONTACT_SLUGS``), which is
    # the correct value for an upload-only bot and for a site with no contact
    # page. Derived, never authored: no API field and no admin control writes
    # it, so a recrawl is always free to replace it.
    derived_contact_url = Column(String, nullable=True)
```

- [ ] **Step 2: Create the migration**

Create `api/alembic/versions/b1000004contact_add_bot_derived_contact_url.py`:

```python
"""Derive each bot's contact page from its own knowledge base.

``bots.derived_contact_url``
    The contact page found among the bot's crawled source URLs, stamped by
    ``repository.sync_bot_knowledge_state`` after every knowledge mutation.

WHY: the Free pricing pivot hands a visitor the customer's public contact page
when it refuses to quote a price, and it sourced that page from a ``contact``
Smart Link the admin had to add by hand. Nobody added one (0 of 18 bots on the
development database), so the pivot never fired and every Free bot fell through
to answering pricing questions from its unrestricted knowledge base -- exactly
the stale-price outcome the gate exists to prevent. The crawler already stored
the contact page; this column lets the gate use it.

Read only as a FALLBACK behind ``answer_links``, so an admin who HAS configured
a Smart Link keeps control.

No data migration: NULL is correct for every existing row, and
``scripts/backfill_bot_derived_contact_url.py`` populates them from the
documents already in the database.

No index: read one row at a time off a ``bots`` row already loaded by primary
key on every chat turn.

Revision ID: b1000004contact
Revises: b1000003pricing
Create Date: 2026-09-07

"""

import sqlalchemy as sa
from alembic import op

revision = "b1000004contact"
down_revision = "b1000003pricing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("derived_contact_url", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "derived_contact_url")
```

- [ ] **Step 3: Run the migration**

```bash
cd api && uv run alembic upgrade head
```

Expected: `Running upgrade b1000003pricing -> b1000004contact`

- [ ] **Step 4: Verify the column exists and the head moved**

```bash
cd api && uv run alembic heads && uv run python -c "
from sqlalchemy import inspect
from app.db.session import engine
cols = [c['name'] for c in inspect(engine).get_columns('bots')]
assert 'derived_contact_url' in cols, cols
print('derived_contact_url present OK')
"
```

Expected: `b1000004contact (head)` and `derived_contact_url present OK`

- [ ] **Step 5: Verify downgrade works, then re-upgrade**

```bash
cd api && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: both complete without error.

- [ ] **Step 6: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/b1000004contact_add_bot_derived_contact_url.py
git commit -m "feat: add bots.derived_contact_url column"
```

---

## Task 3: Stamp the derived URL during knowledge sync

**Files:**
- Modify: `api/app/db/repository.py` (`sync_bot_knowledge_state`, line ~533)
- Test: `api/tests/test_knowledge_links.py` (append a DB-backed class)

- [ ] **Step 1: Write the failing test**

First, extend the import block at the TOP of `api/tests/test_knowledge_links.py` (ruff enforces E402, so these must not be appended mid-file). The top of the file becomes:

```python
"""Contact-page detection from a bot's own crawled source URLs."""

from __future__ import annotations

import os

import pytest

from app.db.models import Bot, Client, Document
from app.db.repository import sync_bot_knowledge_state
from app.services.knowledge_links import detect_contact_url
```

Then APPEND the rest to the end of the file:

```python
pytestmark_db = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="knowledge-sync stamping needs a reachable Postgres at DB_URL",
)


def _bot_with_sources(db, *, urls, source="crawl"):
    client = Client(name="c", email=f"kl{id(urls)}@e.com", api_key=f"kl{id(urls)}", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-kl-{id(urls)}", name="B", is_active=True)
    db.add(bot)
    db.flush()
    for i, url in enumerate(urls):
        db.add(
            Document(
                client_id=client.id,
                bot_id=bot.id,
                document_name=url,
                source=source,
                content=f"chunk {i} with words",
                file_hash=f"h{i}-{id(urls)}",
                embedding=[0.0] * 768,
            )
        )
    db.commit()
    return bot


@pytestmark_db
class TestSyncStampsDerivedContactUrl:
    def test_stamps_the_contact_page_found_in_the_crawl(self, db):
        bot = _bot_with_sources(db, urls=["https://x.com/", "https://x.com/contact-us"])
        sync_bot_knowledge_state(db, bot.id)
        db.commit()
        db.refresh(bot)
        assert bot.derived_contact_url == "https://x.com/contact-us"

    def test_stamps_none_when_the_crawl_found_no_contact_page(self, db):
        bot = _bot_with_sources(db, urls=["https://x.com/", "https://x.com/about"])
        sync_bot_knowledge_state(db, bot.id)
        db.commit()
        db.refresh(bot)
        assert bot.derived_contact_url is None

    def test_clears_a_stale_value_when_the_page_is_gone(self, db):
        """The stamp must never outlive the knowledge it describes, the same
        rule ``crawl_completed_at`` already follows."""
        bot = _bot_with_sources(db, urls=["https://x.com/contact"])
        sync_bot_knowledge_state(db, bot.id)
        db.commit()
        db.refresh(bot)
        assert bot.derived_contact_url == "https://x.com/contact"

        db.query(Document).filter(Document.bot_id == bot.id).delete()
        db.commit()
        sync_bot_knowledge_state(db, bot.id)
        db.commit()
        db.refresh(bot)
        assert bot.derived_contact_url is None

    def test_uploads_are_not_scanned(self, db):
        """An uploaded file merely NAMED like a contact page is not a URL a
        visitor can open."""
        bot = _bot_with_sources(db, urls=["contact-us"], source="upload")
        sync_bot_knowledge_state(db, bot.id)
        db.commit()
        db.refresh(bot)
        assert bot.derived_contact_url is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -k TestSyncStamps -v --no-cov
```

Expected: FAIL — `assert None == 'https://x.com/contact-us'` (nothing stamps it yet)

- [ ] **Step 3: Implement the stamping**

In `api/app/db/repository.py`, inside `sync_bot_knowledge_state`, after `chunk_count = count_documents_for_bot(session, bot_id=bot_id)` add:

```python
    # Re-derive the bot's contact page from the pages it currently stores. Done
    # HERE, beside the chunk counter, because both answer the same question
    # ("what does this bot actually hold right now?") and both must be
    # recomputed by every path that changes knowledge: crawl, upload, delete.
    # Deriving it from a single crawl's output would miss deletions and leave a
    # link to a page the bot no longer knows about.
    #
    # Only ``crawl`` rows are scanned: an uploaded file named "contact-us" is
    # not a URL a visitor can open, and ``document_name`` holds a filename for
    # uploads. ``detect_contact_url`` would reject it anyway; filtering here
    # keeps the scan small on bots with large uploaded corpora.
    from sqlalchemy import distinct, select

    from app.services.knowledge_links import detect_contact_url

    source_urls = (
        session.execute(
            select(distinct(Document.document_name)).where(
                Document.bot_id == bot_id,
                Document.source == "crawl",
            )
        )
        .scalars()
        .all()
    )
    bot.derived_contact_url = detect_contact_url(source_urls)
```

Verify `Document` is already imported at the top of `repository.py`; if not, add it to the existing `from app.db.models import ...` line.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -v --no-cov
```

Expected: PASS (all, including the 4 new DB tests)

- [ ] **Step 5: Lint, format, commit**

```bash
cd api && uv run ruff check app/db/repository.py tests/test_knowledge_links.py && uv run ruff format app/db/repository.py tests/test_knowledge_links.py
git add api/app/db/repository.py api/tests/test_knowledge_links.py
git commit -m "feat: stamp derived_contact_url during knowledge sync"
```

---

## Task 4: Resolve contact URL with admin-config precedence

**Files:**
- Modify: `api/app/services/rag_service.py` (add `resolve_contact_url`; update lines ~6574 and ~8111)
- Test: `api/tests/test_pricing_gate_contact_fallback.py` (create)

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_pricing_gate_contact_fallback.py`:

```python
"""Contact-URL resolution for the pricing pivot: Smart Link first, crawl second.

An admin-configured ``contact`` Smart Link must always beat the value derived
from the crawl, because explicit configuration beats inference. The derived
value exists to serve the overwhelmingly common case where no Smart Link was
ever configured.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.rag_service import resolve_contact_url


def _bot(*, answer_links=None, derived=None):
    return SimpleNamespace(answer_links=answer_links, derived_contact_url=derived)


class TestResolveContactUrl:
    def test_smart_link_wins_over_the_derived_value(self):
        bot = _bot(
            answer_links=[{"keyword": "contact", "url": "https://admin-chose.com/contact"}],
            derived="https://crawled.com/contact-us",
        )
        assert resolve_contact_url(bot) == "https://admin-chose.com/contact"

    def test_falls_back_to_the_derived_value(self):
        bot = _bot(answer_links=None, derived="https://crawled.com/contact-us")
        assert resolve_contact_url(bot) == "https://crawled.com/contact-us"

    def test_falls_back_when_smart_links_hold_no_contact_entry(self):
        bot = _bot(
            answer_links=[{"keyword": "pricing", "url": "https://x.com/pricing"}],
            derived="https://crawled.com/contact",
        )
        assert resolve_contact_url(bot) == "https://crawled.com/contact"

    def test_returns_none_when_neither_exists(self):
        assert resolve_contact_url(_bot()) is None

    def test_an_unusable_derived_value_is_treated_as_absent(self):
        """Defence in depth: this string is pasted into a visitor's reply and
        persisted to ``chat_messages.content``."""
        assert resolve_contact_url(_bot(derived="javascript:alert(1)")) is None

    def test_no_bot_is_safe(self):
        assert resolve_contact_url(None) is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && uv run pytest tests/test_pricing_gate_contact_fallback.py -v --no-cov
```

Expected: FAIL with `ImportError: cannot import name 'resolve_contact_url'`

- [ ] **Step 3: Add the resolver**

In `api/app/services/rag_service.py`, immediately AFTER the `_contact_url_from_answer_links` function (it ends with `return None` around line 1646) add:

```python
def resolve_contact_url(bot: object) -> str | None:
    """The contact page to hand a visitor, preferring what the admin configured.

    Two sources, in strict precedence order:

    1. A ``contact`` Smart Link in ``bot.answer_links``, which an admin typed
       deliberately.
    2. ``bot.derived_contact_url``, found by the crawler among the bot's own
       pages and stamped by ``repository.sync_bot_knowledge_state``.

    Explicit beats inferred, so an admin who HAS configured a Smart Link never
    has it silently overridden by a page a crawl happened to find. In practice
    the fallback is what fires: 0 of 18 bots on the development database had a
    ``contact`` Smart Link, which is why the Free pricing pivot -- whose entire
    job is to hand this page over -- never fired, and every Free bot fell
    through to answering pricing questions from its unrestricted knowledge base.

    The derived value is re-validated through ``_pricing_gate.normalize_url``
    even though ``detect_contact_url`` already applied it. This string is pasted
    into a visitor's reply and persisted to ``chat_messages.content``, so the
    check is repeated at the point of use rather than trusted from storage: a
    hand-edited row must not be able to render
    "You can get in touch here: javascript:alert(1)".
    """
    if bot is None:
        return None
    configured = _contact_url_from_answer_links(getattr(bot, "answer_links", None))
    if configured:
        return configured
    derived = getattr(bot, "derived_contact_url", None)
    if isinstance(derived, str):
        candidate = derived.strip()
        if _pricing_gate.normalize_url(candidate):
            return candidate
    return None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && uv run pytest tests/test_pricing_gate_contact_fallback.py -v --no-cov
```

Expected: PASS (6 tests)

- [ ] **Step 5: Wire it into both pipelines**

There are exactly two callsites, one per pipeline. Both currently read:

```python
            _contact_url = _contact_url_from_answer_links(getattr(bot, "answer_links", None))
```

Replace BOTH (line ~6574 in the non-streaming pipeline, line ~8111 in the streaming pipeline) with:

```python
            _contact_url = resolve_contact_url(bot)
```

Confirm exactly two replacements were made:

```bash
cd api && grep -n "resolve_contact_url(bot)" app/services/rag_service.py
grep -c "_contact_url_from_answer_links(getattr(bot" app/services/rag_service.py
```

Expected: two `resolve_contact_url(bot)` lines; count of the old call is `0`.

- [ ] **Step 6: Run the full pricing-gate suite**

```bash
cd api && uv run pytest tests/ -k "pricing_gate or knowledge_links or contact" --no-cov -q
```

Expected: all pass.

- [ ] **Step 7: Lint, format, commit**

```bash
cd api && uv run ruff check app/services/rag_service.py tests/test_pricing_gate_contact_fallback.py && uv run ruff format app/services/rag_service.py tests/test_pricing_gate_contact_fallback.py
git add api/app/services/rag_service.py api/tests/test_pricing_gate_contact_fallback.py
git commit -m "feat: fall back to the crawled contact page in the pricing pivot"
```

---

## Task 5: End-to-end — a Free bot now escalates instead of standing down

**Files:**
- Test: `api/tests/test_pricing_gate_contact_fallback.py` (append)

This is the task that proves the whole point of the change.

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_pricing_gate_contact_fallback.py`:

```python
from app.services import pricing_gate as pg


class TestFreeBotNoLongerStandsDown:
    """The behaviour change this feature exists to deliver.

    Before: a Free bot with no ``pricing_url`` and no ``contact`` Smart Link hit
    ``no_support_path_standdown``, the gate passed the chunks through untouched,
    and the knowledge base answered the pricing question -- potentially with a
    stale price off an old uploaded rate card.

    After: the contact page derived from its own crawl gives the gate somewhere
    to send the visitor, so it escalates and hands over that page instead.
    """

    def test_derived_contact_url_prevents_the_standdown(self):
        bot = _bot(answer_links=None, derived="https://crawled.com/contact-us")
        contact = resolve_contact_url(bot)

        assert pg.no_support_path_standdown(
            support_enabled=False, pricing_url=None, contact_url=contact
        ) is False

    def test_the_gate_escalates_and_empties_the_chunks(self):
        """``chunks=[]`` is the "regardless of the knowledge base" guarantee:
        the contact link is the WHOLE reply, never a link appended to a stale
        knowledge-base price."""
        bot = _bot(answer_links=None, derived="https://crawled.com/contact-us")
        stale = [SimpleNamespace(document_name="https://crawled.com/old-rates", content="Plans from $99")]

        decision = pg.evaluate_pricing_gate(
            question="how much does it cost?",
            quote_active=False,
            pricing_url=None,
            chunks=stale,
            support_enabled=False,
            contact_url=resolve_contact_url(bot),
        )

        assert decision.fired is True
        assert decision.outcome == "escalate_no_url"
        assert decision.chunks == []

    def test_the_visitor_is_handed_the_derived_page(self):
        bot = _bot(answer_links=None, derived="https://crawled.com/contact-us")
        pivot = pg.pricing_pivot(
            company_name="CleanStart",
            pricing_url=None,
            support_enabled=False,
            live_chat_enabled=False,
            contact_url=resolve_contact_url(bot),
        )

        assert "https://crawled.com/contact-us" in pivot.text
        # Free has no in-chat channel: a link is information, never a promise.
        assert pivot.suggest_handoff is False
        assert pivot.needs_message_card is False

    def test_a_bot_with_nothing_at_all_still_stands_down(self):
        """Unchanged behaviour, recorded so a future edit notices it. Removing
        this last standdown is a separate product decision (see the plan's
        Open Decisions)."""
        assert pg.no_support_path_standdown(
            support_enabled=False, pricing_url=None, contact_url=resolve_contact_url(_bot())
        ) is True
```

- [ ] **Step 2: Run the tests**

```bash
cd api && uv run pytest tests/test_pricing_gate_contact_fallback.py -v --no-cov
```

Expected: PASS (10 tests). These pass on the Task 4 implementation — they are the regression lock, not new production code.

- [ ] **Step 3: Commit**

```bash
git add api/tests/test_pricing_gate_contact_fallback.py
git commit -m "test: pin that a derived contact page stops the Free standdown"
```

---

## Task 6: Backfill existing bots

**Files:**
- Create: `api/scripts/backfill_bot_derived_contact_url.py`

- [ ] **Step 1: Write the script**

Create `api/scripts/backfill_bot_derived_contact_url.py`:

```python
"""Stamp ``bots.derived_contact_url`` on bots crawled before the column existed.

DRY-RUN BY DEFAULT. Pass ``--execute`` to write.

``repository.sync_bot_knowledge_state`` now derives each bot's contact page from
its crawled pages, but it only runs when knowledge changes. A bot whose last
crawl predates this feature keeps a NULL column until someone re-crawls it, and
until then its Free pricing questions still fall through to the knowledge base.
This reconciles every existing row in one pass.

Idempotent: re-running changes nothing once the column agrees with the crawl.

Usage:
    cd api && uv run python scripts/backfill_bot_derived_contact_url.py
    cd api && uv run python scripts/backfill_bot_derived_contact_url.py --bot-id 13
    cd api && uv run python scripts/backfill_bot_derived_contact_url.py --execute
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import distinct, select  # noqa: E402

from app.db.models import Bot, Document  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.services.knowledge_links import detect_contact_url  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--execute", action="store_true", help="Write the derived URLs (default: dry run).")
    parser.add_argument("--bot-id", type=int, default=None, help="Restrict to a single bot id.")
    args = parser.parse_args()

    changed: list[tuple[int, str, str, str]] = []
    with get_session() as session:
        query = session.query(Bot)
        if args.bot_id is not None:
            query = query.filter(Bot.id == args.bot_id)
        bots = query.order_by(Bot.id).all()

        for bot in bots:
            urls = (
                session.execute(
                    select(distinct(Document.document_name)).where(
                        Document.bot_id == bot.id,
                        Document.source == "crawl",
                    )
                )
                .scalars()
                .all()
            )
            found = detect_contact_url(urls)
            if found == bot.derived_contact_url:
                continue
            changed.append((bot.id, bot.name or "(unnamed)", bot.derived_contact_url or "NULL", found or "NULL"))
            if args.execute:
                bot.derived_contact_url = found

        if args.execute and changed:
            session.commit()

    if not changed:
        print(f"Checked {len(bots)} bots: already consistent, nothing to do.")
        return 0

    verb = "Stamped" if args.execute else "Would stamp"
    print(f"{verb} {len(changed)} of {len(bots)} bots:\n")
    print(f"{'BOT':>6}  {'NAME':<24} {'STORED':<28} -> {'DERIVED'}")
    for bot_id, name, stored, found in changed:
        print(f"{bot_id:>6}  {name[:24]:<24} {stored[:28]:<28} -> {found}")
    if not args.execute:
        print("\nDry run. Re-run with --execute to write these values.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Dry-run it**

```bash
cd api && uv run python scripts/backfill_bot_derived_contact_url.py
```

Expected on the development database — bots 13 and 29 gain a contact page:

```
    13  mega bot                 NULL      -> https://www.cleanstart.com/contact-us
    29  Chatbot                  NULL      -> https://fynix.digital/contact
```

- [ ] **Step 3: Execute and verify idempotency**

```bash
cd api && uv run python scripts/backfill_bot_derived_contact_url.py --execute
cd api && uv run python scripts/backfill_bot_derived_contact_url.py
```

Expected: the second run prints `already consistent, nothing to do.`

- [ ] **Step 4: Verify the real behaviour change on bot 29 (a Free bot)**

```bash
cd api && uv run python -c "
from app.db.session import SessionLocal
from app.db.models import Bot
from app.services.rag_service import resolve_contact_url
from app.services import pricing_gate as pg
from app.services import plan_entitlements_service as pes
s = SessionLocal()
b = s.get(Bot, 29)
ent = pes.get_bot_entitlements(29, s, use_cache=False)
support = bool(ent.features.get('live_chat'))
contact = resolve_contact_url(b)
print('plan          =', ent.plan_slug)
print('contact_url   =', contact)
print('stands down?  =', pg.no_support_path_standdown(support_enabled=support, pricing_url=b.pricing_url, contact_url=contact))
d = pg.evaluate_pricing_gate(question='how much does it cost?', quote_active=False,
                             pricing_url=b.pricing_url, chunks=[], support_enabled=support, contact_url=contact)
print('outcome       =', d.outcome, '| fired =', d.fired)
s.close()
"
```

Expected: `stands down? = False` and `outcome = escalate_no_url | fired = True` (before this change it was `True` / `no_support_path_standdown`).

- [ ] **Step 5: Lint, format, commit**

```bash
cd api && uv run ruff check scripts/backfill_bot_derived_contact_url.py && uv run ruff format scripts/backfill_bot_derived_contact_url.py
git add api/scripts/backfill_bot_derived_contact_url.py
git commit -m "feat: backfill derived_contact_url for existing bots"
```

---

## Task 7: Warn when `pricing_url` matches nothing in the knowledge base

Bot 13 has `pricing_url = https://www.oyechats.com/pricing` while its entire knowledge base is `cleanstart.com` — so **every** pricing question escalates with `escalate_no_content`, and nothing in the product tells anyone. The correct page (`cleanstart.com/pricing`) is already crawled.

This task surfaces the mismatch. It deliberately does NOT auto-substitute (see Open Decisions).

**Files:**
- Modify: `api/app/services/knowledge_links.py`
- Test: `api/tests/test_knowledge_links.py`

- [ ] **Step 1: Write the failing test**

Add `detect_pricing_url` and `pricing_url_is_in_knowledge_base` to the EXISTING `from app.services.knowledge_links import ...` line at the top of `api/tests/test_knowledge_links.py`, so it reads:

```python
from app.services.knowledge_links import (
    detect_contact_url,
    detect_pricing_url,
    pricing_url_is_in_knowledge_base,
)
```

Then append the new class to the end of the file:

```python
class TestPricingUrlDiagnostics:
    def test_reports_a_named_page_that_is_present(self):
        urls = ["https://www.cleanstart.com/pricing", "https://www.cleanstart.com/about"]
        assert pricing_url_is_in_knowledge_base("https://cleanstart.com/pricing/", urls) is True

    def test_reports_a_named_page_that_is_absent(self):
        """Bot 13's real misconfiguration: the named page is on a different
        domain from everything the bot crawled."""
        urls = ["https://www.cleanstart.com/pricing", "https://www.cleanstart.com/about"]
        assert pricing_url_is_in_knowledge_base("https://www.oyechats.com/pricing", urls) is False

    def test_an_unset_url_is_not_a_mismatch(self):
        assert pricing_url_is_in_knowledge_base(None, ["https://x.com/pricing"]) is False

    def test_suggests_the_pricing_page_found_in_the_crawl(self):
        urls = ["https://www.cleanstart.com/", "https://www.cleanstart.com/pricing"]
        assert detect_pricing_url(urls) == "https://www.cleanstart.com/pricing"

    def test_suggests_nothing_when_no_pricing_page_was_crawled(self):
        assert detect_pricing_url(["https://x.com/", "https://x.com/about"]) is None

    def test_a_deep_page_mentioning_pricing_is_not_suggested(self):
        assert detect_pricing_url(["https://x.com/blog/our-pricing-philosophy"]) is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -k TestPricingUrlDiagnostics -v --no-cov
```

Expected: FAIL with `ImportError: cannot import name 'detect_pricing_url'`

- [ ] **Step 3: Implement**

Append to `api/app/services/knowledge_links.py`:

```python
#: Whole-path slugs that identify a pricing page, same narrow rule as
#: ``CONTACT_SLUGS``.
PRICING_SLUGS: frozenset[str] = frozenset({"pricing", "price", "prices", "plans", "packages", "rates"})


def detect_pricing_url(source_urls: Iterable[object] | None) -> str | None:
    """The pricing page found among a bot's crawled URLs, or None.

    ADVISORY ONLY. This is NOT wired into ``evaluate_pricing_gate`` and must not
    be: the gate's guarantee is that a bot prices only from the page its OWNER
    NAMED, and auto-selecting one would let it quote from a page nobody
    sanctioned (an old ``/plans`` page, a regional rate card). It exists to tell
    an admin which page they probably meant when the one they typed matches
    nothing they have crawled.
    """
    if not source_urls:
        return None
    candidates: list[tuple[int, str, str]] = []
    for raw in source_urls:
        if not isinstance(raw, str):
            continue
        candidate = raw.strip()
        normalized = normalize_url(candidate)
        if normalized is None:
            continue
        path = _path_of(normalized)
        if path in PRICING_SLUGS:
            candidates.append((len(path), path, candidate))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][2]


def pricing_url_is_in_knowledge_base(pricing_url: object, source_urls: Iterable[object] | None) -> bool:
    """Whether the configured ``pricing_url`` matches any page the bot stores.

    False for an unset URL as well as a mismatched one; callers that need to
    tell those apart should check the URL themselves first. Comparison is the
    same ``normalize_url`` equality ``evaluate_pricing_gate`` uses to filter
    chunks, so this answers exactly the question "will the gate ever find a
    chunk for this URL?" -- a bot answering False escalates EVERY pricing
    question, which is invisible in the admin UI today.
    """
    target = normalize_url(pricing_url)
    if target is None or not source_urls:
        return False
    return any(isinstance(u, str) and normalize_url(u) == target for u in source_urls)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && uv run pytest tests/test_knowledge_links.py -v --no-cov
```

Expected: PASS (all)

- [ ] **Step 5: Report the mismatch on the development database**

```bash
cd api && uv run python -c "
from sqlalchemy import distinct, select
from app.db.session import SessionLocal
from app.db.models import Bot, Document
from app.services.knowledge_links import detect_pricing_url, pricing_url_is_in_knowledge_base
s = SessionLocal()
for b in s.query(Bot).order_by(Bot.id).all():
    if not b.pricing_url:
        continue
    urls = s.execute(select(distinct(Document.document_name)).where(Document.bot_id==b.id, Document.source=='crawl')).scalars().all()
    ok = pricing_url_is_in_knowledge_base(b.pricing_url, urls)
    if not ok:
        print(f'bot {b.id} {b.name!r}: pricing_url={b.pricing_url} matches NOTHING; did you mean {detect_pricing_url(urls)}?')
s.close()
"
```

Expected:

```
bot 13 'mega bot': pricing_url=https://www.oyechats.com/pricing matches NOTHING; did you mean https://www.cleanstart.com/pricing?
```

- [ ] **Step 6: Lint, format, commit**

```bash
cd api && uv run ruff check app/services/knowledge_links.py tests/test_knowledge_links.py && uv run ruff format app/services/knowledge_links.py tests/test_knowledge_links.py
git add api/app/services/knowledge_links.py api/tests/test_knowledge_links.py
git commit -m "feat: detect a mis-set pricing_url against the knowledge base"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run every mandatory check**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

Expected: `All checks passed!`, `N files already formatted`, and the full suite green (baseline before this work: **7039 passed, 6 skipped**, coverage 75.52%).

- [ ] **Step 2: Confirm the branch**

```bash
cd platform && git branch --show-current
```

Expected: `development`. If it prints `main`, run `git checkout development` and do not commit.

- [ ] **Step 3: Push**

```bash
cd platform && git push origin development
```

---

## Open Decisions (need a product call, NOT blocking this plan)

1. **Should the last Free standdown be removed?**
   After this change a Free bot with no `pricing_url`, no Smart Link AND no crawled contact page still stands down and lets the knowledge base answer. Auto-detection shrinks this population a lot but does not empty it (bots 28 and 44 have knowledge bases too small to contain a contact page). Removing it entirely matches the stated spec — "regardless of pricing keywords in the knowledge base" — and the reply copy already exists and is tested in `pricing_pivot`, currently unreachable. Cost: that visitor gets no price and no link. Implementation: delete the `no_support_path_standdown` branch from `evaluate_pricing_gate` AND update the two cache-bypass callsites (`rag_service.py:6805`, `:8342`) in the same commit, or a pre-gate cached price gets served ahead of the gate.

2. **Should `detect_pricing_url` ever be used as a fallback?**
   Task 7 keeps it advisory. Wiring it into the gate would fix bot 13 automatically but weakens the "owner-named source" guarantee that is the gate's entire reason to exist. Recommended: surface it in the admin Voice section as a suggestion the owner confirms, rather than applying it silently.

3. **Where should the mismatch warning surface?**
   Task 7 ships the detection only. The natural home is the admin Voice section beside the `pricing_url` field, and/or the agent Overview health card. That is a dashboard change in `app/` and is not planned here.
