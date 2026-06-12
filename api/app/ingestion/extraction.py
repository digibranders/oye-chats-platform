import docx
from pypdf import PdfReader


class ExtractionError(Exception):
    """Raised when a file produces no usable text after extraction.

    Most commonly triggered by **scanned PDFs** (image-only pages with no
    embedded text layer). The caller can catch this to surface a clear
    message to the user instead of silently storing zero chunks.
    """


def load_pdf(file_path: str) -> list[dict]:
    """
    Extract text from PDF and return a list of dictionaries
    containing text and metadata (page number).

    Raises:
        ExtractionError: when every page yielded empty text — almost always
            a scanned PDF. Run OCR before upload.
    """
    with open(file_path, "rb") as f:
        reader = PdfReader(f)
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


def load_docx(file_path: str) -> list[dict]:
    """
    Extract text from DOCX and return a list of dictionaries.
    DOCX doesn't have a strict concept of 'pages' like PDF in common libraries,
    so we'll treat it as one 'page' for simplicity or split by paragraphs if needed.

    Raises:
        ExtractionError: when the document contains no paragraphs with text.
    """
    doc = docx.Document(file_path)
    full_text = [para.text for para in doc.paragraphs if para.text]

    text_content = "\n".join(full_text).strip()
    if not text_content:
        raise ExtractionError("No extractable text in DOCX. The document appears to be empty or image-only.")

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]


def load_txt(file_path: str) -> list[dict]:
    """
    Extract text from TXT or MD files.

    Raises:
        ExtractionError: when the file is empty after decoding.
    """
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text_content = f.read()

    if not text_content.strip():
        raise ExtractionError("The uploaded text file is empty.")

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]
