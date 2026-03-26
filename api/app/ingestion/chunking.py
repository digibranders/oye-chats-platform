# Chunking of the text

from langchain_core.documents import Document as LCDocument
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import CHUNK_OVERLAP, CHUNK_SIZE


def chunk_text(pages_data: list[dict]) -> list[LCDocument]:
    """
    Split text into chunks while preserving metadata.
    """
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
        is_separator_regex=False,
    )

    # Convert our simplified pages_data to LangChain Documents
    documents = [LCDocument(page_content=p["text"], metadata=p["metadata"]) for p in pages_data]

    # Split documents (metadata is automatically preserved/propagated)
    chunks = text_splitter.split_documents(documents)

    # Add chunk index to metadata
    for i, chunk in enumerate(chunks):
        chunk.metadata["chunk_index"] = i

    return chunks
