# Chunking of the text

from langchain_core.documents import Document as LCDocument
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import CHUNK_OVERLAP, CHUNK_SIZE

# Markdown-aware separators: prefer splitting at document structure boundaries
# before falling back to paragraphs, sentences, and words.
_SEPARATORS = [
    "\n## ",
    "\n### ",
    "\n#### ",
    "\n\n",
    "\n",
    ". ",
    " ",
    "",
]


def chunk_text(pages_data: list[dict], document_name: str = "") -> list[LCDocument]:
    """Split text into chunks while preserving metadata.

    Args:
        pages_data: List of ``{"text": ..., "metadata": ...}`` dicts.
        document_name: Optional source document name used to build a
            contextual prefix that is prepended to each chunk so embeddings
            carry richer semantic signal.
    """
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
        is_separator_regex=False,
        separators=_SEPARATORS,
    )

    # Convert our simplified pages_data to LangChain Documents
    documents = [LCDocument(page_content=p["text"], metadata=p["metadata"]) for p in pages_data]

    # Split documents (metadata is automatically preserved/propagated)
    chunks = text_splitter.split_documents(documents)

    # Build a reusable contextual prefix from the document name
    doc_prefix = f"[Document: {document_name}] " if document_name else ""

    # Enrich each chunk with contextual prefix and chunk index
    for i, chunk in enumerate(chunks):
        chunk.metadata["chunk_index"] = i

        # Prepend document context so the embedding captures source identity
        prefix = doc_prefix
        title = chunk.metadata.get("title")
        if title:
            prefix += f"[Title: {title}] "
        page = chunk.metadata.get("page")
        if page is not None:
            prefix += f"[Page: {page}] "
        if prefix:
            chunk.page_content = prefix + chunk.page_content

    return chunks
