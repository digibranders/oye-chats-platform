"""File-to-text extraction for uploaded knowledge (PDF, DOCX, TXT/MD).

Each loader returns ``[{"text": str, "metadata": {"page": int, "total_pages":
int}}]`` and raises :class:`ExtractionError` when the file yields nothing the
pipeline can chunk. The error message is shown to the customer verbatim by the
upload route, so every message here says what is wrong with the file AND what
to do about it.
"""

import codecs
from collections.abc import Iterator

import docx
from docx.blkcntnr import BlockItemContainer
from docx.document import Document as DocxDocument
from docx.table import Table
from pypdf import PasswordType, PdfReader
from pypdf.errors import DependencyError, PdfReadError


class ExtractionError(Exception):
    """Raised when a file produces no usable text after extraction.

    Most commonly triggered by **scanned PDFs** (image-only pages with no
    embedded text layer). The caller can catch this to surface a clear
    message to the user instead of silently storing zero chunks.
    """


# ── PDF ─────────────────────────────────────────────────────────────────────


_PDF_MISSING_CRYPTO_MESSAGE = (
    "This PDF is encrypted and the server is missing the library needed to open it. "
    "Please contact support, or re-save the PDF without encryption and re-upload."
)
_PDF_UNSUPPORTED_ENCRYPTION_MESSAGE = (
    "This PDF uses an encryption scheme we cannot open. "
    "Re-save it without encryption (for example, print it to a new PDF) and re-upload."
)


def _open_pdf(handle) -> PdfReader:
    """Construct the reader, turning pypdf's encryption failures into messages
    the customer can act on.

    pypdf reads the /Encrypt dictionary and tries the empty user password
    inside ``PdfReader.__init__`` itself, so a missing crypto dependency
    (``DependencyError``) or an unsupported scheme (``NotImplementedError``,
    the only exception ``pypdf/_encryption.py`` raises for an unknown /V,
    /SubFilter or crypt-filter method) surfaces HERE, not on the first
    ``.pages`` access. Catching those only in ``_unlock_pdf`` left its branches
    unreachable and the upload UI on its generic "something went wrong". A
    ``PdfReadError`` from the constructor is a corrupt or non-PDF file, never
    an encryption problem, and propagates unchanged.
    """
    try:
        return PdfReader(handle)
    except DependencyError as exc:
        raise ExtractionError(_PDF_MISSING_CRYPTO_MESSAGE) from exc
    except NotImplementedError as exc:
        raise ExtractionError(_PDF_UNSUPPORTED_ENCRYPTION_MESSAGE) from exc


def _unlock_pdf(reader: PdfReader) -> None:
    """Open an encrypted PDF that needs no password; reject one that does.

    Most "encrypted" PDFs are owner-locked only (print/copy restrictions) and
    open with the empty user password. pypdf already tries that on
    construction, and the explicit ``decrypt("")`` here is what makes the
    outcome inspectable: a PDF that genuinely needs a password used to surface
    as pypdf's ``FileNotDecryptedError`` on the first ``.pages`` access, a
    generic failure the upload UI rendered as "something went wrong", leaving
    the customer with nothing to act on. The dependency and unsupported-scheme
    cases are normally caught by ``_open_pdf`` already; they are kept here for
    a reader constructed elsewhere.
    """
    try:
        outcome = reader.decrypt("")
    except DependencyError as exc:
        # AES-encrypted files need the ``cryptography`` package. It is a
        # declared dependency, so this only fires on a broken install; say so
        # rather than blaming the customer's file.
        raise ExtractionError(_PDF_MISSING_CRYPTO_MESSAGE) from exc
    except (PdfReadError, NotImplementedError) as exc:
        raise ExtractionError(_PDF_UNSUPPORTED_ENCRYPTION_MESSAGE) from exc
    if outcome == PasswordType.NOT_DECRYPTED:
        raise ExtractionError(
            "This PDF is password-protected. Remove the password "
            "(for example, print it to a new PDF or export it without a password) and re-upload."
        )


def load_pdf(file_path: str) -> list[dict]:
    """
    Extract text from PDF and return a list of dictionaries
    containing text and metadata (page number).

    Raises:
        ExtractionError: when the PDF is password-protected, or when every
            page yielded empty text. The latter is almost always a scanned
            PDF. Run OCR before upload.
    """
    with open(file_path, "rb") as f:
        reader = _open_pdf(f)
        if reader.is_encrypted:
            _unlock_pdf(reader)
        total_pages = len(reader.pages)
        pages_data = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                pages_data.append({"text": text, "metadata": {"page": i + 1, "total_pages": total_pages}})

    if not pages_data:
        raise ExtractionError(
            f"No extractable text in PDF ({total_pages} page(s)). "
            "This is almost always a scanned/image-based PDF. "
            "Run OCR (e.g. via Tesseract or Adobe Acrobat) and re-upload."
        )

    return pages_data


# ── DOCX ────────────────────────────────────────────────────────────────────


def _table_rows_as_text(table: Table) -> Iterator[str]:
    """Yield one pipe-delimited line per table row (``| Plan | Price |``).

    A pipe row keeps the cells of one record on one line, so a chunk that
    lands on the row can still answer "what does the Pro plan cost" without
    the header row travelling with it. Word reports a horizontally merged cell
    once per grid column it spans (the same cell object repeated), so a cell
    is emitted once and the columns it spans are skipped.
    """
    for row in table.rows:
        cells: list[str] = []
        skip = 0
        for cell in row.cells:
            if skip:
                skip -= 1
                continue
            skip = max(0, cell.grid_span - 1)
            # A cell's paragraphs join with newlines; a pipe row must stay on
            # one line.
            cells.append(" ".join(cell.text.split()))
        if any(cells):
            yield "| " + " | ".join(cells) + " |"


def _iter_block_text(container: BlockItemContainer | DocxDocument) -> Iterator[str]:
    """Yield the text of every paragraph and table in ``container``, in document order.

    ``doc.paragraphs`` is only the body's top-level paragraphs: every table was
    dropped, so a pricing sheet or a spec laid out as a table uploaded as an
    empty-looking document. ``iter_inner_content`` walks the body's ``w:p`` and
    ``w:tbl`` children in the order they appear, which keeps a table between
    the paragraphs that introduce and discuss it.
    """
    for block in container.iter_inner_content():
        if isinstance(block, Table):
            yield from _table_rows_as_text(block)
        elif block.text:
            yield block.text


def _iter_header_footer_text(doc: DocxDocument) -> Iterator[str]:
    """Yield each distinct header/footer line once.

    Headers and footers commonly carry the company name, the document title,
    a version or a confidentiality notice, all useful to retrieval. Sections
    repeat the same header, and a section marked "linked to previous" simply
    inherits its predecessor's, so repeated lines are emitted once. The
    linked check also stops python-docx from materialising an empty header
    part on a section that has none.
    """
    seen: set[str] = set()
    odd_even = bool(doc.settings.odd_and_even_pages_header_footer)
    for section in doc.sections:
        parts = [section.header, section.footer]
        if section.different_first_page_header_footer:
            parts += [section.first_page_header, section.first_page_footer]
        if odd_even:
            parts += [section.even_page_header, section.even_page_footer]
        for part in parts:
            if part.is_linked_to_previous:
                continue
            for line in _iter_block_text(part):
                if line not in seen:
                    seen.add(line)
                    yield line


def load_docx(file_path: str) -> list[dict]:
    """
    Extract text from DOCX and return a list of dictionaries.

    Body paragraphs and tables are emitted in document order (tables as
    pipe-delimited rows), followed by the section headers and footers. DOCX
    has no page concept the library can see, so the document is one "page".

    Raises:
        ExtractionError: when the document contains no text at all.
    """
    doc = docx.Document(file_path)
    lines = [*_iter_block_text(doc), *_iter_header_footer_text(doc)]

    text_content = "\n".join(lines).strip()
    if not text_content:
        raise ExtractionError("No extractable text in DOCX. The document appears to be empty or image-only.")

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]


# ── TXT / MD ────────────────────────────────────────────────────────────────

_UTF32_BOMS = (codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)
_UTF16_BOMS = (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)


def decode_text_bytes(raw: bytes) -> str:
    """Decode an uploaded text file, honouring its BOM before guessing.

    The old read was hard-coded UTF-8 with ``errors="ignore"``, which silently
    destroyed text: a UTF-16 export from Windows Notepad decoded to a run of
    NULs, and a Windows-1252 file (the default of Excel "Save as text" and
    older Word) lost every ``é``, curly quote and dash. Order of attempts:

    1. A UTF-32 or UTF-16 BOM is decisive: decode as that encoding.
    2. Strict ``utf-8-sig``: valid UTF-8, with or without its BOM. The BOM is
       consumed so it does not become a ``\\ufeff`` character in the text.
    3. Strict ``cp1252``: the byte values UTF-8 rejects are almost always
       Windows-1252 accented letters and typographic punctuation.
    4. UTF-8 with ``errors="replace"``: the file is mixed or corrupt; a visible
       U+FFFD marks each bad byte instead of dropping it.
    """
    if raw.startswith(_UTF32_BOMS):
        return raw.decode("utf-32", errors="replace")
    if raw.startswith(_UTF16_BOMS):
        return raw.decode("utf-16", errors="replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("cp1252")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def load_txt(file_path: str) -> list[dict]:
    """
    Extract text from TXT or MD files.

    Raises:
        ExtractionError: when the file is empty after decoding.
    """
    with open(file_path, "rb") as f:
        raw = f.read()

    # Text-mode reads used to translate line endings (universal newlines);
    # keep that so a CRLF file re-uploaded unchanged still hashes the same.
    text_content = decode_text_bytes(raw).replace("\r\n", "\n").replace("\r", "\n")

    if not text_content.strip():
        raise ExtractionError("The uploaded text file is empty.")

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]
