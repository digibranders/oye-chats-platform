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
to be sent anything. Nor is every sentence with "pdf" in it about the business's
files: "can I download reports as pdf?" asks about a feature, and "send me the
invoice pdf for my order" is about the visitor's own paperwork. Both belong to
the model.

The catalog is ``repository.get_bot_media_urls`` payloads: dicts with a ``files``
list of ``{"url", "name"}``. Nothing here sends email: the reply points at
download cards, or offers the team when the bot has no matching file. Pure: no
database, no model, no import from ``rag_service``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote

from app.ingestion.cleaner import is_valid_file_url

#: Content words a question and a file name must share before the file counts as
#: the one asked for. ``rag_service`` attaches a topical card on the same bar, so
#: both paths agree on what "clearly about this file" means: two words in common
#: ("red" + "teaming") is one subject, one ("model", "report") is usually
#: incidental. A question with a single topic word is exact when a file carries
#: it ("the SOAR datasheet").
TOPIC_MIN_OVERLAP = 2

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

#: Contact details a visitor adds to a request ("email it to rahul.sharma@gmail.com",
#: "my number is 98765 43210", a link). They name no document, so they are removed
#: before a question is read: left in, "rahul" or "gmail" became the topic of the
#: request and no file matched it.
_CONTACT_RE = re.compile(
    r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"  # an email address
    r"|\b(?:https?://|www\.)\S+"  # a link
    r"|\+?\d(?:[\s.-]?\d){6,}",  # a phone number: 7 or more digits, with spaces, dashes or dots between
    re.IGNORECASE,
)

#: Where one thought ends and the next begins. The rules below judge the clause a
#: document is named in, so "send me your brochure, my number is ..." is read as a
#: request followed by contact details, not as a question about "my" file.
_CLAUSE_BREAK = re.compile(r"[,;:.!?]|\s(?:and|but|also)\s", re.IGNORECASE)
_NOUN_RE = re.compile(rf"\b{_ANY_NOUN}\b", re.IGNORECASE)
#: Every document noun except a bare pdf.
_NAMED_DOCUMENT_RE = re.compile(rf"\b(?:{_FILE_NOUNS}|catalog(?:ue)?s?|decks?)\b", re.IGNORECASE)
#: "your brochure", "your latest 2026 brochure": the business's own document. It
#: keeps "can you share your brochure with our team" and "how can I get your
#: brochure?" requests, which the ownership and how-to rules would otherwise drop.
_YOUR_DOCUMENT_RE = re.compile(rf"\byour\s+(?:[a-z0-9-]+\s+){{0,2}}{_ANY_NOUN}\b", re.IGNORECASE)
#: The visitor's own paperwork: "the pdf of my contract", "my payslip pdf". A
#: possessive that only gives contact details ("to my email", "my number") does
#: not count.
_VISITORS_OWN_RE = re.compile(
    r"\b(?:my|our)\b(?!\s+(?:e-?mail|mail|inbox|whatsapp|phone|mobile|number|contact|address|id)\b)",
    re.IGNORECASE,
)
#: A how-to question: "how do I send a pdf to a customer", "how do I download the ebook I bought".
_HOW_TO_RE = re.compile(r"\bhow\s+(?:do|can|should)\s+(?:i|we)\b", re.IGNORECASE)
#: A file sent to the business: "can I send you my pdf", "email you my brochure file".
_TO_THE_BUSINESS_RE = re.compile(
    r"\b(?:send|share|e-?mail|mail|forward|upload)\s+(?:(?:it|them|this|these|that)\s+)?(?:(?:to|with)\s+)?you\b",
    re.IGNORECASE,
)
_PRODUCT = r"(?:bot|chatbot|widget|app|dashboard|platform|tool|system|users?|customers?|visitors?|leads?|clients?)"
#: The product, or the visitor's own audience, handling the file: a feature question.
_PRODUCT_RULES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # Doing the action: "can users download invoices", "does the bot share brochures".
        rf"\b{_PRODUCT}\s+(?:(?:can|could|will|would|to)\s+)?(?:send|share|e-?mail|mail|forward|download|upload"
        r"|get|give|export)\b",
        # Receiving it: "send my brochure to leads", "share brochures with visitors".
        rf"\b(?:to|with)\s+(?:(?:a|an|the|my|our|your|all|their)\s+)?{_PRODUCT}\b",
        # Where it happens: "in the app", "from the dashboard", "using your tool".
        rf"\b(?:in|from|using|via|through|inside)\s+(?:(?:a|the|my|our|your)\s+)?{_PRODUCT}\b",
    )
)
#: A file format, not a file: "can I download reports as pdf?", "export to pdf".
_AS_PDF_RE = re.compile(r"\b(?:as|to|in(?:to)?)\s+(?:a\s+)?pdfs?\b", re.IGNORECASE)
#: A number of documents to be made is an order: "I need 1000 brochures". A year
#: ("your 2026 brochure") and a singular noun are not a quantity.
_QUANTITY_RE = re.compile(rf"\b(?!(?:19|20)\d\d\b)\d{{2,}}\s+{_ANY_NOUN}(?<=s)\b", re.IGNORECASE)


@dataclass(frozen=True)
class DocumentPick:
    """Download cards to offer. ``exact`` is True when they match what was asked for."""

    docs: list[dict[str, str]]
    exact: bool


def _without_contacts(text: str) -> str:
    return _CONTACT_RE.sub(" ", text)


def _is_not_for_a_business_file(clause: str) -> bool:
    """True when a clause names a document but is not asking for one of the business's files."""
    if not _NOUN_RE.search(clause):
        return False
    if not _YOUR_DOCUMENT_RE.search(clause) and (_VISITORS_OWN_RE.search(clause) or _HOW_TO_RE.search(clause)):
        return True
    if _TO_THE_BUSINESS_RE.search(clause) or any(rule.search(clause) for rule in _PRODUCT_RULES):
        return True
    if _AS_PDF_RE.search(clause) and not _NAMED_DOCUMENT_RE.search(clause):
        return True
    return bool(_QUANTITY_RE.search(clause))


def is_document_request(question: object) -> bool:
    """True when the visitor asks for one of the business's downloadable documents.

    Not a service that makes one ("do you design brochures?"), a feature question
    ("can users download invoices as pdf"), or the visitor's own file ("send me
    the invoice pdf for my order").
    """
    if not isinstance(question, str) or not question.strip():
        return False
    text = _without_contacts(question)
    if any(rule.search(text) for rule in _SERVICE_RULES):
        return False
    if not any(rule.search(text) for rule in _REQUEST_RULES):
        return False
    return not any(_is_not_for_a_business_file(clause) for clause in _CLAUSE_BREAK.split(text))


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
    text = _without_contacts(question)
    return any(rule.search(text) for rule in _DELIVERY_RULES)


#: Kinds of document: the kind, how a question names it, and how a file name
#: carries it once URL-decoded. A kind no question names here still marks a file,
#: so a report is never the exact answer to a request for a datasheet.
_KINDS: tuple[tuple[str, re.Pattern[str] | None, re.Pattern[str]], ...] = tuple(
    (kind, re.compile(asked, re.IGNORECASE) if asked else None, re.compile(carried, re.IGNORECASE))
    for kind, asked, carried in (
        ("brochure", r"brochure", r"brochure"),
        ("datasheet", r"data\s*sheet", r"data[\W_]*sheet"),
        ("spec sheet", r"spec\s*sheet", r"spec[\W_]*sheet"),
        ("whitepaper", r"white\s*paper", r"white[\W_]*paper"),
        ("case study", r"case\s+stud", r"case[\W_]*stud"),
        ("catalog", r"catalog", r"catalog"),
        ("deck", r"\bdecks?\b", r"deck"),
        ("one-pager", r"one[- ]?pager", r"one[\W_]*pager"),
        # Not the "ebook" inside "facebook".
        ("ebook", r"\be-?books?\b", r"(?<!fac)e[\W_]*book"),
        # A "Risk Profile Assessment" is not the company's profile.
        ("company profile", r"company\s+profile", r"company[\W_]*profile"),
        ("report", None, r"report"),
    )
)
#: Asks for the company as a whole, answered by a profile-like file when the
#: catalog has nothing of the kind named.
_GENERIC_KINDS = frozenset({"brochure", "company profile"})
#: File names that describe the whole company.
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


def _tokens(text: str | None) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) >= 3 and t not in _STOPWORDS}


def _asked_kinds(text: str) -> frozenset[str]:
    return frozenset(kind for kind, asked, _ in _KINDS if asked is not None and asked.search(text))


@dataclass(frozen=True)
class _File:
    """A usable catalog file: its download card and what its name says."""

    card: dict[str, str]
    tokens: frozenset[str]
    kinds: frozenset[str]
    profile_like: bool

    @property
    def url(self) -> str:
        return self.card["url"]


def _catalog_files(catalog: object, company: set[str]) -> list[_File]:
    """Every usable file in the catalog, once.

    The card is named the way ``rag_service._topical_media_card`` names one, so a
    card from here looks the same as one attached to a generated answer. Matching
    reads the URL-decoded name without the company's own words, which would
    otherwise count toward every file the company named after itself.
    """
    files: list[_File] = []
    seen: set[str] = set()
    for payload in catalog if isinstance(catalog, list) else []:
        if not isinstance(payload, dict):
            continue
        for entry in payload.get("files") or []:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            if not is_valid_file_url(url) or url in seen:
                continue
            seen.add(url)
            raw = entry.get("name")
            name = (raw if isinstance(raw, str) and raw.strip() else url.split("?", 1)[0].rsplit("/", 1)[-1]).strip()
            readable = unquote(name)
            files.append(
                _File(
                    card={"type": "download", "url": url, "name": name or "download"},
                    tokens=frozenset(_tokens(readable) - company),
                    kinds=frozenset(kind for kind, _, carried in _KINDS if carried.search(readable)),
                    profile_like=bool(_PROFILE_RE.search(readable)),
                )
            )
    return files


def _conflicts(asked: frozenset[str], file: _File) -> bool:
    """True when the question names a kind and the file is plainly another kind."""
    return bool(asked and file.kinds and not asked & file.kinds)


def _offer(first: _File, others: list[_File], *, exact: bool, limit: int) -> DocumentPick:
    """``first`` as the card, then the others that belong beside it.

    The caller passes, for an exact pick, only files as good as the first. An
    inexact pick is a guess, so a second file rides along only when it is the
    same kind as the first: two spec sheets, not a datasheet and a report.
    """
    companions = others if exact else [f for f in others if f.kinds & first.kinds]
    return DocumentPick(docs=[f.card for f in (first, *companions)][:limit], exact=exact)


def pick_documents(question: str, company_name: str | None, catalog: object, limit: int = 2) -> DocumentPick:
    """The files to offer for a document request.

    A question that names a topic ("the SOC as a Service datasheet") gets the
    files whose names share the most words with it. That pick is exact when the
    best file shares at least ``TOPIC_MIN_OVERLAP`` words, every topic word, or
    every one of the file's own topic words ("the brochure for MBA program"
    against ``MBA-Brochure.pdf``, whose only topic word is "mba"), and is not
    plainly another kind of document than the one asked for; a weaker match is
    offered as inexact. A file name with no topic words of its own (a bare
    "Brochure.pdf") is never made exact by that last rule. When no file shares
    a word, or the question names only a kind ("any case studies?"), the files
    of that kind are offered,
    exact only when there was no topic to miss. A request for a brochure or a
    company profile, or one naming neither a kind nor a topic, falls back to
    profile-like files, marked inexact. Anything else gets no files: never an
    unrelated one, like a third-party report the knowledge base happens to link.

    Contact details are ignored. Ties break on the URL, so the same question
    against the same catalog always offers the same files. ``limit`` defaults to
    two: one card and one "Also available" chip, the most the generated path ever
    attaches.
    """
    text = _without_contacts(question if isinstance(question, str) else "")
    company = _tokens(company_name)
    anchor = _tokens(text) - company
    asked = _asked_kinds(text)
    files = _catalog_files(catalog, company)

    if anchor:
        scored = sorted(
            ((len(anchor & f.tokens), f) for f in files if anchor & f.tokens),
            key=lambda sf: (-sf[0], _conflicts(asked, sf[1]), sf[1].url),
        )
        if scored:
            best_overlap, best = scored[0]
            covers_file_name = bool(best.tokens) and best.tokens <= anchor
            exact = (
                best_overlap >= TOPIC_MIN_OVERLAP or best_overlap == len(anchor) or covers_file_name
            ) and not _conflicts(asked, best)
            others = [
                f for overlap, f in scored[1:] if not exact or (overlap == best_overlap and not _conflicts(asked, f))
            ]
            return _offer(best, others, exact=exact, limit=limit)

    of_kind = sorted((f for f in files if asked & f.kinds), key=lambda f: f.url)
    if of_kind:
        return _offer(of_kind[0], of_kind[1:], exact=not anchor, limit=limit)

    generic = asked <= _GENERIC_KINDS and (bool(asked) or not anchor)
    profiles = sorted((f for f in files if f.profile_like), key=lambda f: f.url) if generic else []
    if profiles:
        return _offer(profiles[0], profiles[1:], exact=False, limit=limit)
    return DocumentPick(docs=[], exact=False)


#: A hash or id in a file name, "68d65d47051e1b0ca7a66228" or "29330f6b": noise to a reader.
_HASH_WORD_RE = re.compile(r"[0-9a-f]{8,}", re.IGNORECASE)


def _display(name: str) -> str:
    """A file name as a reader sees it: decoded, no extension, separators as spaces, no ids, no markdown."""
    stem = re.sub(r"\.[a-z0-9]{2,4}$", "", unquote(name), flags=re.IGNORECASE)
    words = re.sub(r"[-_*`\[\]]+", " ", stem).split()
    readable = [word for word in words if not _HASH_WORD_RE.fullmatch(word)]
    # A name that is nothing but an id keeps it: a bare id beats an empty name.
    return " ".join(readable or words) or name


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
