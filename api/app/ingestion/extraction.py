import docx
from pypdf import PdfReader


def load_pdf(file_path: str) -> list[dict]:
    """
    Extract text from PDF and return a list of dictionaries
    containing text and metadata (page number).
    """
    with open(file_path, "rb") as f:
        reader = PdfReader(f)
        pages_data = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                pages_data.append({"text": text, "metadata": {"page": i + 1, "total_pages": len(reader.pages)}})
    return pages_data


def load_docx(file_path: str) -> list[dict]:
    """
    Extract text from DOCX and return a list of dictionaries.
    DOCX doesn't have a strict concept of 'pages' like PDF in common libraries,
    so we'll treat it as one 'page' for simplicity or split by paragraphs if needed.
    """
    doc = docx.Document(file_path)
    full_text = []
    for para in doc.paragraphs:
        full_text.append(para.text)

    text_content = "\n".join(full_text)

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]


def load_txt(file_path: str) -> list[dict]:
    """
    Extract text from TXT or MD files.
    """
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text_content = f.read()

    return [{"text": text_content, "metadata": {"page": 1, "total_pages": 1}}]
