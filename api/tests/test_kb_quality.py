"""Detectors for crawled content that must never be served as fact.

Production, 2026-09-10: Eventus claimed to operate in about 250 countries (a
crawled form's country dropdown) and CleanStart gave out "(555) 123-4567" (a
placeholder on its own site).
"""

import itertools
import os

import pytest

from app.db.models import Bot, Client, Document
from app.services.kb_quality import is_option_list, placeholder_contacts
from scripts.kb_junk_report import find_junk_chunks

COUNTRIES = "Australia Austria Azerbaijan Bahamas Bahrain Bangladesh Barbados Belarus Belgium Belize Benin Bermuda Bhutan Bolivia Botswana Brazil Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus Denmark Egypt Estonia Finland France"

US_STATES = "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma"

INDIAN_STATES = "Andhra Pradesh Arunachal Pradesh Assam Bihar Chhattisgarh Goa Gujarat Haryana Himachal Pradesh Jharkhand Karnataka Kerala Madhya Pradesh Maharashtra Manipur Meghalaya Mizoram Nagaland Odisha Punjab Rajasthan Sikkim Tamil Nadu Telangana Tripura Uttar Pradesh Uttarakhand West Bengal"


def test_a_country_dropdown_is_an_option_list():
    assert is_option_list(COUNTRIES) is True


def test_prose_mentioning_a_few_countries_is_not():
    assert (
        is_option_list("We have offices in India, the United States and Germany, serving clients in Canada.") is False
    )


def test_a_us_state_dropdown_is_an_option_list():
    assert is_option_list(US_STATES) is True


def test_an_indian_state_dropdown_is_an_option_list():
    assert is_option_list(INDIAN_STATES) is True


def test_prose_naming_a_handful_of_states_is_not():
    assert is_option_list("We ship to California, Texas and New York, with a support desk in Maharashtra.") is False


def test_placeholder_phone_numbers_and_emails_are_found():
    found = placeholder_contacts("Call +1 (555) 123-4567 or write to hello@example.com. Lorem ipsum dolor sit amet.")
    assert "(555) 123-4567" in found
    assert "hello@example.com" in found
    assert "lorem ipsum" in found


def test_real_contacts_are_not_flagged():
    assert placeholder_contacts("Call +91 789 789 6607 or support@oyechats.com") == []


def test_more_placeholder_patterns_are_found():
    text = (
        "Reach us at your@email.com or yourname@gmail.com or name@company.com. "
        "Sample data: xxx-xxx-xxxx, 000-000-0000, 123-456-7890, (123) 456-7890, "
        "call 1234567890 or visit 123 Main Street / 123 Main St."
    )
    found = placeholder_contacts(text)
    assert "your@email.com" in found
    assert "yourname@gmail.com" in found
    assert "name@company.com" in found
    assert "xxx-xxx-xxxx" in found
    assert "000-000-0000" in found
    assert "123-456-7890" in found
    assert "(123) 456-7890" in found
    assert "1234567890" in found
    assert "123 Main Street" in found
    assert "123 Main St" in found


def test_more_real_looking_contacts_are_not_flagged():
    # 022 5551 2345 contains the digits "555" but not as a standalone token,
    # so it must not be mistaken for the 555 fictional-number placeholder.
    # 1800 123 4567 is a real Indian toll-free format. 123 MG Road is a real
    # Bengaluru address, not the "123 Main Street" placeholder.
    found = placeholder_contacts("Call 022 5551 2345 or our toll-free 1800 123 4567. Visit us at 123 MG Road.")
    assert found == []


def test_reserved_555_01xx_numbers_are_flagged_even_with_a_real_area_code():
    # 555-0100 through 555-0199 are reserved by NANPA for fictional use in any
    # North American area code, so this is flagged even though it reads like
    # a genuine business line.
    found = placeholder_contacts("+1 415 555 0199 is our Palo Alto line")
    assert "415 555 0199" in found


def test_is_option_list_stays_linear_on_a_large_chunk():
    import time

    content = ("Ask us about our services in Springfield. " * 2500)[:100_000]
    assert len(content) == 100_000

    start = time.perf_counter()
    is_option_list(content)
    placeholder_contacts(content)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.2


# ── find_junk_chunks (the read-only report) ──────────────────────────────────
#
# Real Postgres, via the shared ``db`` fixture: the function runs a real
# SELECT against the real ``documents`` table and must never write to it.

_seq = itertools.count(1)
_EMBEDDING = [0.0] * 768


def _make_client(db) -> Client:
    n = next(_seq)
    client = Client(
        name=f"KB Quality Client {n}",
        email=f"kbq{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"kbq-api-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client: Client) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-kbq-{n}", name="KB Quality Bot")
    db.add(bot)
    db.commit()
    return bot


def _add_document(db, *, client: Client, bot: Bot, name: str, content: str, is_active: bool = True) -> Document:
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=name,
        source="crawl",
        file_hash=f"hash-{name}-{next(_seq)}",
        content=content,
        embedding=_EMBEDDING,
        is_active=is_active,
    )
    db.add(doc)
    db.commit()
    return doc


class TestFindJunkChunks:
    pytestmark = pytest.mark.skipif(
        os.getenv("DB_URL") is None,
        reason="find_junk_chunks integration tests need a reachable Postgres at DB_URL",
    )

    def test_flags_an_option_list_chunk_by_id_and_reason(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(db, client=client, bot=bot, name="https://eventus.example/signup", content=COUNTRIES)

        findings = find_junk_chunks(db, bot.id)

        assert len(findings) == 1
        assert findings[0].document_name == "https://eventus.example/signup"
        assert any("option list" in reason for reason in findings[0].reasons)

    def test_flags_a_placeholder_contact_chunk(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="contact.html",
            content="Call us at (555) 123-4567 any time.",
        )

        findings = find_junk_chunks(db, bot.id)

        assert len(findings) == 1
        assert any("(555) 123-4567" in reason for reason in findings[0].reasons)

    def test_clean_content_is_not_flagged(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="about.html",
            content="We are a small team in Bangalore helping local shops with their books.",
        )

        assert find_junk_chunks(db, bot.id) == []

    def test_inactive_chunks_are_not_scanned(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="stale.html",
            content="Call us at (555) 123-4567 any time.",
            is_active=False,
        )

        assert find_junk_chunks(db, bot.id) == []

    def test_only_scans_the_given_bot(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        other_bot = _make_bot(db, client)
        _add_document(db, client=client, bot=other_bot, name="other.html", content=COUNTRIES)

        assert find_junk_chunks(db, bot.id) == []

    def test_never_prints_chunk_content(self, db, capsys):
        client = _make_client(db)
        bot = _make_bot(db, client)
        secret = "my personal phone is nine one one, do not repeat this"
        _add_document(
            db,
            client=client,
            bot=bot,
            name="private.html",
            content=f"Call us at (555) 123-4567. {secret}",
        )

        find_junk_chunks(db, bot.id)

        assert secret not in capsys.readouterr().out
