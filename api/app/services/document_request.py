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
from bisect import bisect_left
from collections.abc import Callable
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

#: Nouns a document noun can describe instead of name: "case study sessions",
#: "the ebook bundle", "whitepaper topic ideas", "the brochure printer". The
#: visitor is asking about that other thing, not for the document.
_HEAD_NOUNS = frozenset(
    {
        "idea", "ideas", "topic", "topics", "session", "sessions", "workshop", "workshops", "module", "modules",
        "bundle", "bundles", "draft", "drafts", "template", "templates", "design", "designs", "writing", "printing",
        "printer", "refund", "edition", "price", "prices", "value", "values", "format", "review", "reviews",
        "feedback",
    }
)  # fmt: skip
_NOT_A_HEAD = rf"(?![\s-]+(?:{'|'.join(sorted(_HEAD_NOUNS))})\b)"

#: Requests that need no ask verb: a document followed by a request word.
_NOUN_THEN_REQUEST_RULES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # "is the brochure available?", "case study please".
        rf"\b{_FILE_NOUNS}\b{_NOT_A_HEAD}[^.?!]{{0,20}}\b(?:please|pls|available|downloadable|download)\b",
        # "a product catalogue I can download". Not "pdf": "the pdf file won't open"
        # and "is the catalog file big" are not requests, and "file(s)" alone is too
        # loose for either noun.
        r"\bcatalog(?:ue)?s?\b[^.?!]{0,20}\bdownload(?:able)?\b",
    )
)
#: The whole message names a document: "any whitepapers?", "Brochure?". Matched
#: against the stripped message, so no leading or trailing whitespace run can
#: make it backtrack.
_WHOLE_MESSAGE_RE = re.compile(rf"(?:(?:any|some|a|the|your)\s+)?{_FILE_NOUNS}\s?[?.!]*", re.IGNORECASE)

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
#: request and no file matched it. Every branch is bounded and an address must
#: start where a run of address characters starts: an unbounded address took 80ms
#: per call on "a" x 2,500 + "@" + "a" x 2,499, and a turn reads a question several
#: times.
_CONTACT_RE = re.compile(
    r"(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}"  # an email address
    r"|\b(?:https?://|www\.)\S{1,2048}"  # a link
    r"|\+?\d(?:[\s.-]?\d){6,14}",  # a phone number: 7 to 15 digits, with spaces, dashes or dots between
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


# ── Does the ask verb govern the document? ──────────────────────────────────
#
# "can I get a refund if the ebook I bought is the wrong edition?" has an ask verb
# and a document noun 25 characters apart, and it asks for a refund. So a verb
# counts only when the document is its object: between them sit at most a
# recipient ("me", "over") and a few words that describe the document ("the
# latest SOAR platform", "a copy of your"). The check walks back from each
# document noun over a bounded number of words, so it stays linear on any input.

#: Where a verb's reach ends. A full stop only when a space or the end follows,
#: so "v2.0" stays one phrase.
_LINK_BREAK = re.compile(r"[,;:!?\n]|\.(?!\w)")
_WORD_RE = re.compile(r"[a-z0-9]+(?:['’][a-z]+)?", re.IGNORECASE)
_FILE_NOUN_RE = re.compile(rf"\b{_FILE_NOUNS}\b", re.IGNORECASE)
_PDF_RE = re.compile(r"\bpdfs?\b", re.IGNORECASE)
_CATALOG_RE = re.compile(r"\bcatalog(?:ue)?s?\b", re.IGNORECASE)

#: Who the document goes to, directly after the verb: "send me", "send over".
_RECIPIENTS = frozenset({"me", "us", "him", "her", "them", "over"})
#: Words that pick out which copy is meant. Not counted toward the limit below.
_DETERMINERS = frozenset({"a", "an", "the", "your", "our", "any", "some", "this", "that", "these", "those"})
#: Words that describe the document: "the latest", "a copy of", "the pdf".
_DESCRIBERS = frozenset(
    {
        "latest", "new", "updated", "recent", "current", "full", "complete", "detailed", "short", "official",
        "company", "product", "products", "service", "services", "digital", "soft", "pdf", "copy", "copies", "link",
        "links", "one", "relevant",
    }
)  # fmt: skip
#: Words that end a verb's reach: they start another phrase ("if", "when", "for",
#: "and"), stand for someone else ("someone", "I") or name what is really asked
#: for ("a refund", "an invoice", "your feedback", "a minute"). Any other word
#: between the verb and the noun is a topic word ("SOC", "red teaming",
#: "healthcare").
_ENDS_THE_REACH = frozenset(
    {
        # Pronouns, question words and possessives that are not the business's.
        "i", "i'm", "im", "you", "u", "he", "she", "it", "it's", "we", "they", "my", "his", "their", "who", "whom",
        "whose", "which", "what", "what's", "whats", "where", "when", "why", "how", "whether", "if", "someone",
        "somebody", "anyone", "anybody", "everyone", "something", "anything", "nothing",
        # Prepositions other than "of", and conjunctions.
        "to", "for", "on", "in", "at", "about", "with", "without", "from", "by", "into", "onto", "after", "before",
        "during", "than", "like", "as", "per", "via", "through", "until", "upon", "within", "regarding", "around",
        "and", "or", "but", "so", "because", "since", "while", "unless", "though", "although", "plus", "then",
        # Auxiliaries and negation.
        "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "can", "could", "will",
        "would", "shall", "should", "may", "might", "must", "has", "had", "have", "having", "not", "no", "never",
        "don't", "dont", "doesn't", "didn't", "won't", "can't", "cannot",
        # What the visitor wants instead of the document.
        "refund", "refunds", "invoice", "invoices", "receipt", "receipts", "discount", "discounts", "feedback",
        "idea", "ideas", "minute", "minutes", "moment", "second", "session", "sessions", "turnaround", "time",
        "quote", "quotes", "quotation", "price", "prices", "pricing", "cost", "costs", "estimate", "update",
        "updates", "reminder", "notification", "opinion", "thoughts", "review",
    }
)  # fmt: skip
#: At most this many describing or topic words between the verb and the noun.
_MAX_DESCRIBING_WORDS = 4
#: How far back the walk looks at all: a copy of your latest red teaming (7 words)
#: plus two recipients and the verb.
_MAX_WALK = 10

_VerbAt = Callable[[tuple[str, ...], int], bool]


@dataclass(frozen=True)
class _Phrase:
    """Text between two link breaks, with its words lowercased and where each starts."""

    text: str
    words: tuple[str, ...]
    starts: tuple[int, ...]


def _phrases(text: str) -> list[_Phrase]:
    phrases = []
    for part in _LINK_BREAK.split(text):
        found = list(_WORD_RE.finditer(part))
        words = tuple(m.group().lower().replace("’", "'") for m in found)
        phrases.append(_Phrase(part, words, tuple(m.start() for m in found)))
    return phrases


def _word(words: tuple[str, ...], index: int) -> str:
    return words[index] if 0 <= index < len(words) else ""


def _can_i_have(words: tuple[str, ...], index: int) -> bool:
    """ "can I have", "could I have", "may I have", ending at ``index``."""
    return (
        words[index] == "have" and _word(words, index - 1) == "i" and _word(words, index - 2) in {"can", "could", "may"}
    )


def _asks_at(words: tuple[str, ...], index: int) -> bool:
    """An ask for a document ends at ``index``: "send", "do you have", "can I have a look at", "u got a"."""
    word = words[index]
    if word == "have":
        # "I have" and "we have" describe the visitor's own copy ("I have a
        # question about your brochure"), unless it is "can I have".
        return _word(words, index - 1) not in {"i", "we"} or _can_i_have(words, index)
    if word == "at":
        # "can I have a look at", "could I take a look at".
        return (
            _word(words, index - 1) == "look"
            and _word(words, index - 2) == "a"
            and _word(words, index - 3) in {"have", "take"}
            and _word(words, index - 4) == "i"
            and _word(words, index - 5) in {"can", "could", "may"}
        )
    if word == "got":
        # "u got a wedding brochure?", "you got any case studies?"
        return _word(words, index - 1) in {"u", "you"} and _word(words, index + 1) in {"a", "an", "any"}
    return word in {
        "send", "share", "email", "mail", "give", "get", "download", "want", "need", "see", "show", "provide",
        "forward",
    }  # fmt: skip


def _hands_over_at(words: tuple[str, ...], index: int) -> bool:
    """A verb that hands a file over. "I want a pdf" or "see the pdf" is too loose for a bare pdf."""
    return _can_i_have(words, index) or words[index] in {
        "send", "share", "email", "mail", "give", "get", "download", "forward",
    }  # fmt: skip


def _sends_at(words: tuple[str, ...], index: int) -> bool:
    """A verb that sends a file. A shop's "catalog of shoes" is its products, so "show" and "get" do not count."""
    return _can_i_have(words, index) or words[index] in {"send", "share", "email", "mail", "download", "forward"}


def _after_recipient(words: tuple[str, ...], index: int, verb_at: _VerbAt) -> bool:
    """True when the recipient at ``index`` ("me", or "me over") directly follows a verb."""
    before = index - 1
    if _word(words, before) in _RECIPIENTS:
        before -= 1
    return before >= 0 and verb_at(words, before)


def _governed(words: tuple[str, ...], noun_index: int, verb_at: _VerbAt) -> bool:
    """True when a verb governs the noun whose first word is ``words[noun_index]``.

    Walking back from the noun, each word must describe it: a determiner, a
    describing word ("latest", "copy", "of"), "link to", or a topic word ("SOAR",
    "red teaming"). A topic word sits next to the noun, so none may come before a
    determiner: "an overview of the whitepaper" asks for an overview. "as a
    service" is part of a name, not a new phrase. A recipient must come straight
    after the verb.
    """
    described = 0
    determiner_seen = False
    index = noun_index - 1
    stop = max(0, noun_index - _MAX_WALK)
    while index >= stop:
        word = words[index]
        if verb_at(words, index):
            return True
        if word in _RECIPIENTS:
            return _after_recipient(words, index, verb_at)
        if word in _DETERMINERS:
            determiner_seen = True
        elif word == "as" and _word(words, index + 1) == "a" and _word(words, index + 2) in {"service", "services"}:
            # "the SOC as a Service datasheet": the "a" belongs to the name.
            determiner_seen = False
        elif word == "of":
            pass
        elif word in {"to", "for"} and _word(words, index - 1) in {"link", "links"}:
            described += 1
            index -= 1
        elif word in _DESCRIBERS or (not determiner_seen and word not in _ENDS_THE_REACH):
            described += 1
        else:
            return False
        if described > _MAX_DESCRIBING_WORDS:
            return False
        index -= 1
    return False


def _verb_governs_a_noun(phrase: _Phrase, nouns: re.Pattern[str], verb_at: _VerbAt) -> bool:
    """True when some noun in the phrase is the object of a verb, not the modifier of another noun."""
    for noun in nouns.finditer(phrase.text):
        after = bisect_left(phrase.starts, noun.end())
        if _word(phrase.words, after) in _HEAD_NOUNS:
            continue
        if _governed(phrase.words, bisect_left(phrase.starts, noun.start()), verb_at):
            return True
    return False


#: Asks that name a document: any ask verb for a named document, a handing-over
#: verb for a pdf, a sending verb for a catalog.
_ASKS: tuple[tuple[re.Pattern[str], _VerbAt], ...] = (
    (_FILE_NOUN_RE, _asks_at),
    (_PDF_RE, _hands_over_at),
    (_CATALOG_RE, _sends_at),
)


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

    The ask verb has to govern the document ("send me the SOAR datasheet"), not
    something else in the sentence ("send me an invoice for the case study
    workshop"). Not a service that makes one ("do you design brochures?"), a
    feature question ("can users download invoices as pdf"), or the visitor's own
    file ("send me the invoice pdf for my order").
    """
    if not isinstance(question, str) or not question.strip():
        return False
    text = _without_contacts(question)
    if any(rule.search(text) for rule in _SERVICE_RULES):
        return False
    asked = (
        any(_verb_governs_a_noun(phrase, nouns, verb_at) for phrase in _phrases(text) for nouns, verb_at in _ASKS)
        or any(rule.search(text) for rule in _NOUN_THEN_REQUEST_RULES)
        or _WHOLE_MESSAGE_RE.fullmatch(text.strip()) is not None
    )
    if not asked:
        return False
    return not any(_is_not_for_a_business_file(clause) for clause in _CLAUSE_BREAK.split(text))


def _delivers_at(words: tuple[str, ...], index: int) -> bool:
    """A verb that asks for the file itself. "have", "see", "show" and "available" ask a question instead."""
    return _can_i_have(words, index) or words[index] in {
        "send", "share", "email", "mail", "forward", "download", "give", "get",
    }  # fmt: skip


def asks_for_delivery(question: object) -> bool:
    """True when the visitor asks for a file to be sent or downloaded, not just
    whether one exists. "do you have", "any", "is there", "see", "show" and
    "available" ask a question; "send", "share", "email", "download", "give",
    "get", "can I have" and "could I have" ask for the file itself, but only when
    the document is what they govern: "can you email me when the new catalog is
    out?" asks for an email about it."""
    if not isinstance(question, str) or not question.strip():
        return False
    text = _without_contacts(question)
    return any(_verb_governs_a_noun(phrase, _NOUN_RE, _delivers_at) for phrase in _phrases(text))


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


#: The ending of a contraction: "don't", "I'm", "Rahul's".
_CONTRACTION_RE = re.compile(r"['’](?:s|t|m|d|ll|re|ve)\b")
#: A short identifier: "Tower B", "Phase 2", "Block C".
_SHORT_ID_RE = re.compile(r"[a-z]|\d{1,2}")
_YEAR_RE = re.compile(r"(?:19|20)\d\d")
_NUMBER_RE = re.compile(r"\d+")
#: "I'm Rahul", "my name is Rahul Sharma", "this is Priya from Infosys": who is
#: asking, never which document. The name words exclude the words that start a
#: sentence about the request instead ("I'm looking for", "this is the").
_NOT_A_NAME = (
    r"(?:a|an|the|from|in|on|at|for|with|to|about|regarding|looking|interested|here|not|just|also|trying|wondering"
    r"|asking|writing|reaching|planning|hoping|sure|very|so|really|still|currently)\b"
)
_SELF_INTRODUCTION_RE = re.compile(
    rf"\b(?:i['’]?m|i\s+am|this\s+is|my\s+name\s+is)\s+(?!{_NOT_A_NAME})[a-z][\w'’-]*"
    rf"(?:\s+(?!{_NOT_A_NAME})[a-z][\w'’-]*)?"
    r"(?:\s+from\s+[a-z][\w&'’-]*(?:\s+[a-z][\w&'’-]*){0,2})?",
    re.IGNORECASE,
)
#: "on whatsapp", "via email": how to send it, never which document.
_CHANNEL_RE = re.compile(r"\b(?:on|via|over|by|through)\s+(?:whatsapp|e-?mail|mail|telegram|sms|text)\b", re.IGNORECASE)


def _tokens(text: str | None) -> set[str]:
    """The topic words of a question or a file name.

    A one-letter or one- or two-digit word joins the word before it, on both
    sides of a match, so "Tower B" is ``tower_b`` and matches ``Tower-B.pdf`` but
    not ``Tower-A.pdf``, and "Phase 2" is not "Phase 1". Left apart, "b" was too
    short to count and "tower" matched both files equally.
    """
    words = re.findall(r"[a-z0-9]+", _CONTRACTION_RE.sub("", (text or "").lower()))
    tokens: set[str] = set()
    index = 0
    while index < len(words):
        word = words[index]
        index += 1
        if len(word) < 3 or word in _STOPWORDS:
            continue
        if index < len(words) and _SHORT_ID_RE.fullmatch(words[index]):
            word = f"{word}_{words[index]}"
            index += 1
        tokens.add(word)
    return tokens


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
        entries = payload.get("files")
        if not isinstance(entries, list):
            continue
        for entry in entries:
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


def _topic(text: str, company: set[str], files: list[_File]) -> set[str]:
    """What the question is about: its tokens without who is asking, the channel,
    the company's own words, or a year no file name carries ("your latest 2026
    brochure" when the catalog holds the 2025 one)."""
    words = _tokens(_CHANNEL_RE.sub(" ", _SELF_INTRODUCTION_RE.sub(" ", text))) - company
    named = set().union(*(f.tokens for f in files))
    return {w for w in words if not (_YEAR_RE.fullmatch(w) and w not in named)}


def _asked_kinds(text: str) -> frozenset[str]:
    return frozenset(kind for kind, asked, _ in _KINDS if asked is not None and asked.search(text))


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
    best file shares at least ``TOPIC_MIN_OVERLAP`` words or every topic word, and
    is not plainly another kind of document than the one asked for; a weaker
    match is offered as inexact. It is also exact when the question names every
    one of the file's own topic words and the file is the kind asked for ("the
    brochure for MBA program" against ``MBA-Brochure.pdf``). That rule needs the
    kind in the file name and a word other than a number: ``SOC.pdf`` is not the
    "SOC 2 report", ``Services.pdf`` not "the managed services case study", and a
    bare "Brochure.pdf" or "Brochure-2025.pdf" is never made exact by it. Among
    equally good files, one of the kind asked for comes first. When no file shares
    a word, or the question names only a kind ("any case studies?"), the files of
    that kind are offered, exact only when there was no topic to miss. A request for a brochure or a
    company profile, or one naming neither a kind nor a topic, falls back to
    profile-like files, marked inexact. Anything else gets no files: never an
    unrelated one, like a third-party report the knowledge base happens to link.

    Contact details, a self-introduction ("I'm Rahul from Infosys") and the
    channel ("on whatsapp") are ignored. Ties break on the URL, so the same question
    against the same catalog always offers the same files. ``limit`` defaults to
    two: one card and one "Also available" chip, the most the generated path ever
    attaches.
    """
    text = _without_contacts(question if isinstance(question, str) else "")
    company = _tokens(company_name)
    files = _catalog_files(catalog, company)
    anchor = _topic(text, company, files)
    asked = _asked_kinds(text)

    if anchor:
        scored = sorted(
            ((len(anchor & f.tokens), f) for f in files if anchor & f.tokens),
            key=lambda sf: (-sf[0], _conflicts(asked, sf[1]), not asked & sf[1].kinds, sf[1].url),
        )
        if scored:
            best_overlap, best = scored[0]
            covers_file_name = (
                bool(asked & best.kinds)
                and bool(best.tokens)
                and best.tokens <= anchor
                and not all(_NUMBER_RE.fullmatch(token) for token in best.tokens)
            )
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
