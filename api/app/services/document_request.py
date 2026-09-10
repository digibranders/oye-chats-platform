"""Requests for downloadable documents, answered from the bot's own file catalog.

On 2026-09-10 "can you send me your brochure?" got "That specific detail sits
with the team" and "email me a datasheet" got a message form, on all four
production bots, including one whose knowledge base holds a catalog of datasheet
PDFs. The bot cannot send email, so the only honest answer is the file itself.

A question that names documents is not always a request for one to be handed
over: "do you have case studies of fintech clients?" on a bot whose case
studies are web pages deserves an answer from those pages, not a file offer.
``asks_for_delivery`` tells the two apart so the caller can fall through to the
normal pipeline when the catalog has nothing exact and the visitor never asked
to be sent anything.

The catalog is ``repository.get_bot_media_urls`` payloads: dicts with a ``files``
list of ``{"url", "name"}``. Nothing here sends email: the reply points at
download cards, or offers the team when the bot has no matching file. Pure: no
database, no model, no import from ``rag_service``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.ingestion.cleaner import _FILE_URL_RE

#: Documents a business hands out. "deck" alone is also a patio or a ship, so
#: only a pitch, sales, slide, investor or company deck counts.
_FILE_NOUNS = (
    r"(?:brochures?|data\s*sheets?|spec\s*sheets?|white\s*papers?|case\s+stud(?:y|ies)|one[- ]?pagers?"
    r"|e-?books?|company\s+profiles?|(?:pitch|sales|slide|investor|company)\s+decks?)"
)
#: Every noun the service rules below look at, including the ones that need a
#: sending verb to count as a request (a pdf, a catalog) and a bare deck.
_ANY_NOUN = rf"(?:{_FILE_NOUNS}|pdfs?|catalog(?:ue)?s?|decks?)"
#: Verbs that ask for a document. "I have" and "we have" describe the visitor's
#: own copy ("I have a question about your brochure"), so only "you have" counts.
_ASK_VERBS = r"(?:send|share|e-?mail|mail|give|get|download|(?<!\bi )(?<!\bwe )have|want|need|see|show|provide|forward)"
#: Verbs that hand a file over. "I want a pdf" or "see the pdf" is too loose.
_PDF_VERBS = r"(?:send|share|e-?mail|mail|give|get|download|forward)"
#: A shop's "catalog of shoes" is its products, so a catalog counts only when it
#: is sent or downloaded.
_CATALOG_VERBS = r"(?:send|share|e-?mail|mail|download|forward)"

_REQUEST_RULES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # An ask followed by a document: "can you send me your brochure?", "do you have a SOAR datasheet".
        rf"\b{_ASK_VERBS}\b[^.?!]{{0,40}}\b{_FILE_NOUNS}\b",
        # A pdf handed over: "can I get the report as a pdf", "share a pdf of the service".
        rf"\b{_PDF_VERBS}\b[^.?!]{{0,40}}\bpdfs?\b",
        # A catalog sent or downloaded: "send me your catalog pdf", "download the product catalogue".
        rf"\b{_CATALOG_VERBS}\b[^.?!]{{0,40}}\bcatalog(?:ue)?s?\b",
        # A document followed by a request word: "is the brochure available?", "case study please".
        rf"\b{_FILE_NOUNS}\b[^.?!]{{0,20}}\b(?:please|pls|available|downloadable|download)\b",
        # A catalog followed by "download": "a product catalogue I can download".
        # Not "pdf": "the pdf file won't open" and "is the catalog file big" are
        # not requests, and "file(s)" alone is too loose for either noun.
        r"\bcatalog(?:ue)?s?\b[^.?!]{0,20}\bdownload(?:able)?\b",
        # The whole message names a document: "any whitepapers?", "Brochure?".
        rf"^\s*(?:any|some|a|the|your)?\s*{_FILE_NOUNS}\s*[?.!]*\s*$",
    )
)

_MAKE_VERBS = r"(?:design|create|make|build|print|write|edit|draft|develop|produce|convert|redesign)"
_MAKING = r"(?:designing|creating|making|building|printing|writing|editing|drafting|developing|producing|converting)"

#: Making or editing a document is a service the business may sell, and that
#: question deserves its answer, not a file.
_SERVICE_RULES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # Someone makes the item: "do you design brochures?", "I need someone to design a brochure".
        # The subject word keeps "send me your design brochure" a request.
        rf"\b(?:you|u|we|i|to|can|could|will|would|someone|anyone)\s+(?:also\s+)?{_MAKE_VERBS}\b"
        rf"[^.?!,;]{{0,25}}\b{_ANY_NOUN}\b",
        # Making as an activity: "printing 500 brochures".
        rf"\b{_MAKING}\b[^.?!,;]{{0,25}}\b{_ANY_NOUN}\b",
        # The item made to order: "a company profile designed for my business", "brochures printed".
        rf"\b{_ANY_NOUN}\s+(?:designed|created|made|built|printed|written|edited|drafted|developed|produced|converted)\b",
        # The item as a line of work or a tool: "brochure design", "case study writing", "pdf editor".
        rf"\b{_ANY_NOUN}\s+(?:design(?:s|ers?|ing)?|printing|writ(?:ing|ers?)|creation|editing|editors?|conversion"
        r"|converters?|readers?|viewers?|makers?|templates?|tools?|software|apps?|services?|agency|agencies)\b",
    )
)

#: Kinds of document a question can name, with the stem that marks a file of
#: that kind once its name is lowercased and stripped to letters and digits.
_KINDS = (
    (re.compile(r"brochure", re.IGNORECASE), "brochure"),
    (re.compile(r"data\s*sheet", re.IGNORECASE), "datasheet"),
    (re.compile(r"spec\s*sheet", re.IGNORECASE), "specsheet"),
    (re.compile(r"white\s*paper", re.IGNORECASE), "whitepaper"),
    (re.compile(r"case\s+stud", re.IGNORECASE), "casestud"),
    (re.compile(r"catalog", re.IGNORECASE), "catalog"),
    (re.compile(r"\bdecks?\b", re.IGNORECASE), "deck"),
    (re.compile(r"one[- ]?pager", re.IGNORECASE), "onepager"),
    (re.compile(r"e-?book", re.IGNORECASE), "ebook"),
    (re.compile(r"profile", re.IGNORECASE), "profile"),
)
#: File names that describe the whole company, offered first for a generic ask.
_PROFILE_RE = re.compile(r"brochure|company[-_ ]?profile|overview|capabilit|corporate", re.IGNORECASE)
#: Words that say how a document is asked for, never which one. Includes
#: greetings, politeness and filler that name no document either: "thanks!
#: could you email me the brochure" and "hey guys send me your brochure" must
#: not treat "thanks" or "guys" as the topic.
_STOPWORDS = frozenset(
    {
        "the", "and", "for", "with", "our", "your", "you", "can", "could", "would", "will", "should", "please", "pls",
        "plz", "kindly", "get", "give", "want", "need", "have", "any", "some", "this", "that", "these", "those", "what",
        "which", "where", "there", "are", "does", "about", "regarding", "from", "over", "also", "just", "like", "send",
        "share", "email", "mail", "download", "downloadable", "see", "show", "provide", "forward", "available", "copy",
        "version", "latest", "link", "links", "pdf", "pdfs", "doc", "docx", "file", "files", "document", "documents",
        "datasheet", "datasheets", "brochure", "brochures", "whitepaper", "whitepapers", "white", "paper", "papers",
        "case", "study", "studies", "catalog", "catalogs", "catalogue", "catalogues", "deck", "decks", "sheet",
        "sheets", "data", "spec", "ebook", "ebooks", "one", "pager", "pagers", "profile", "company", "pitch", "sales",
        "slide", "investor", "product", "products", "info", "information", "details", "detail", "more", "thanks",
        "thank", "thx", "hey", "hello", "hii", "guys", "team", "sir", "madam", "maam", "quick", "quickly", "asap",
        "again", "bro", "dear", "folks", "everyone",
    }
)  # fmt: skip


@dataclass(frozen=True)
class DocumentPick:
    """Download cards to offer. ``exact`` is True when they match what was asked for."""

    docs: list[dict[str, str]]
    exact: bool


def is_document_request(question: object) -> bool:
    """True when the visitor asks for a downloadable document, not a service that makes one."""
    if not isinstance(question, str) or not question.strip():
        return False
    if any(rule.search(question) for rule in _SERVICE_RULES):
        return False
    return any(rule.search(question) for rule in _REQUEST_RULES)


#: Verbs that ask for a document to be handed over, not merely mentioned.
#: "have", "see", "show" and "available" name a document without asking for
#: delivery ("do you have a brochure?" wants an answer, not necessarily a
#: file), so they are deliberately absent here even though they count for
#: ``is_document_request`` above.
_DELIVERY_VERBS = r"(?:send|share|e-?mail|mail|forward|download|give|get)"
_DELIVERY_RULES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        rf"\b{_DELIVERY_VERBS}\b",
        r"\bcan\s+i\s+have\b",
        r"\bcould\s+i\s+have\b",
    )
)


def asks_for_delivery(question: object) -> bool:
    """True when the visitor asks for a file to be sent or downloaded, not just
    whether one exists. "do you have", "any", "is there", "see", "show" and
    "available" ask a question; "send", "share", "email", "download", "give",
    "get", "can I have" and "could I have" ask for the file itself."""
    if not isinstance(question, str) or not question.strip():
        return False
    return any(rule.search(question) for rule in _DELIVERY_RULES)


def _is_file_url(url: object) -> bool:
    """The check ``rag_service._is_valid_file_url`` applies to every catalog card.

    The ingestion regex at position 0 (http(s), a known download extension), and a
    path after the host, which rejects old junk entries like a bare ``https://hub.doc``.
    """
    if not isinstance(url, str) or not _FILE_URL_RE.match(url):
        return False
    return "/" in url[url.find("://") + 3 :]


def _tokens(text: str | None) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) >= 3 and t not in _STOPWORDS}


def _catalog_files(catalog: object) -> list[dict[str, str]]:
    """Every usable file in the catalog, once, as a download card.

    Named the way ``rag_service._topical_media_card`` names a card, so a card from
    here looks the same as one attached to a generated answer.
    """
    files: list[dict[str, str]] = []
    seen: set[str] = set()
    for payload in catalog if isinstance(catalog, list) else []:
        if not isinstance(payload, dict):
            continue
        for entry in payload.get("files") or []:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            if not _is_file_url(url) or url in seen:
                continue
            seen.add(url)
            raw = entry.get("name")
            name = raw if isinstance(raw, str) and raw.strip() else url.split("?", 1)[0].rsplit("/", 1)[-1]
            files.append({"type": "download", "url": url, "name": name.strip() or "download"})
    return files


def pick_documents(question: str, company_name: str | None, catalog: object, limit: int = 2) -> DocumentPick:
    """The files to offer for a document request.

    A question that names a topic ("the SOC as a Service datasheet") gets the files
    whose names share a word with it, or nothing. One that names only a kind ("any
    case studies?") gets the files of that kind. Otherwise the company profile or
    brochure comes first, marked inexact. Ties break on the URL, so the same
    question against the same catalog always offers the same files.

    ``limit`` defaults to two: one card and one "Also available" chip, the most the
    generated path ever attaches.
    """
    files = _catalog_files(catalog)
    company = _tokens(company_name)
    anchor = _tokens(question) - company
    if anchor:
        scored = sorted(
            ((len(anchor & (_tokens(f["name"]) - company)), f) for f in files),
            key=lambda sf: (-sf[0], sf[1]["url"]),
        )
        return DocumentPick(docs=[f for score, f in scored if score > 0][:limit], exact=True)

    stems = [stem for kind, stem in _KINDS if kind.search(question or "")]
    by_kind = [f for f in files if any(stem in re.sub(r"[^a-z0-9]", "", f["name"].lower()) for stem in stems)]
    if by_kind:
        return DocumentPick(docs=sorted(by_kind, key=lambda f: f["url"])[:limit], exact=True)
    profile = sorted((f for f in files if _PROFILE_RE.search(f["name"])), key=lambda f: f["url"])
    rest = sorted((f for f in files if f not in profile), key=lambda f: f["url"])
    return DocumentPick(docs=(profile + rest)[:limit], exact=False)


def _display(name: str) -> str:
    """A file name as a reader sees it: no extension, separators as spaces, no markdown."""
    stem = re.sub(r"\.[a-z0-9]{2,4}$", "", name, flags=re.IGNORECASE)
    cleaned = " ".join(re.sub(r"[-_*`\[\]]+", " ", stem).split())
    return cleaned or name


def _listing(docs: list[dict[str, str]]) -> str:
    names = [f"**{_display(d['name'])}**" for d in docs]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def document_reply(pick: DocumentPick, *, company_name: str | None, support_enabled: bool) -> str:
    """The words above the download cards. The cards carry the links, so the text names the files only."""
    if not pick.docs:
        if support_enabled:
            return (
                "I don't have a downloadable document for that here. "
                "Want me to connect you with the team so they can share it?"
            )
        about = f"about **{company_name}** " if company_name else ""
        return f"I don't have a downloadable document for that here, but you'll find more {about}on our website."
    verb = "is" if len(pick.docs) == 1 else "are"
    if pick.exact:
        return f"Here you go: {_listing(pick.docs)} {verb} ready to download below."
    return f"I don't have that exact document, but {_listing(pick.docs)} {verb} available to download below."
