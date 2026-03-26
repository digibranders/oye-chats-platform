import os
import shutil
import hashlib
from datetime import datetime
from typing import List, Dict, Any
from app.ingestion.extraction import load_pdf, load_docx, load_txt
from app.ingestion.cleaner import clean_text
from app.ingestion.chunking import chunk_text
from app.ingestion.embedder import embed_chunks

from app.db.repository import insert_documents, is_document_processed
from app.db.session import get_session
from app.config import ARCHIVE_DIR
import logging

logger = logging.getLogger(__name__)

os.makedirs(ARCHIVE_DIR, exist_ok=True)

def calculate_hash(text: str) -> str:
    """Calculate SHA-256 hash of text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def _ingest_document(client_id: int, source_name: str, full_text: str, pages_data: List[Dict[str, Any]], bot_id: int = None) -> int:
    """
    Common ingestion logic for both files and web content.
    Returns the number of chunks processed (0 if skipped).
    Supports both client_id (legacy) and bot_id (new multi-bot).
    """
    # 1. Calculate hash of the cleaned full text
    cleaned_text = clean_text(full_text)
    file_hash = calculate_hash(cleaned_text)

    with get_session() as session:
        already_processed = is_document_processed(session, client_id, file_hash, bot_id=bot_id)

        if already_processed:
            logger.info(f"Skipping {source_name} (Already processed for client {client_id}, bot {bot_id})")
            return 0

        # 2. Chunk text (Preserves metadata)
        chunks = chunk_text(pages_data)

        # Extract content and metadata for external processing
        chunk_contents = [c.page_content for c in chunks]

        # Enhance metadata with source info
        current_time = datetime.utcnow().isoformat()
        chunk_metadatas = []
        for c in chunks:
            meta = c.metadata.copy()
            meta["source"] = source_name
            meta["ingest_date"] = current_time
            chunk_metadatas.append(meta)

        # 3. Embed chunks
        if not chunk_contents:
            logger.warning(f"No content to embed for {source_name}")
            return 0

        embeddings = embed_chunks(chunk_content_list=chunk_contents)

        # 4. Save to Database with JSONB metadata
        try:
            insert_documents(
                session,
                client_id,
                source_name,
                file_hash,
                chunk_contents,
                embeddings,
                chunk_metadatas,
                bot_id=bot_id
            )
            session.commit()
        except Exception as e:
            session.rollback()
            raise e

    return len(chunk_contents)


def run_folder_ingestion(client_id: int, folder_path: str, bot_id: int = None):

    """
    Scan folder and ingest all supported files.
    Supports bot_id for multi-bot architecture.
    """
    supported_extensions = [".pdf", ".docx", ".txt", ".md"]
    files = [f for f in os.listdir(folder_path) if any(f.lower().endswith(ext) for ext in supported_extensions)]

    processed_count = 0
    for file_name in files:
        file_path = os.path.join(folder_path, file_name)
        ext = os.path.splitext(file_name)[1].lower()

        logger.info(f"Processing {file_name} (type: {ext})")

        try:
            # Step 1: Extract text and metadata based on extension
            if ext == ".pdf":
                pages_data = load_pdf(file_path)
            elif ext == ".docx":
                pages_data = load_docx(file_path)
            elif ext in [".txt", ".md"]:
                pages_data = load_txt(file_path)
            else:
                logger.warning(f"File type {ext} unexpectedly reached folder ingestion. Skipping.")
                continue

            if not pages_data:
                logger.warning(f"No text extracted from {file_name}. Skipping.")
                continue
            
            # combine text for hashing and cleaning
            full_raw_text = " ".join([p["text"] for p in pages_data])
            
            # Delegate to common ingestion logic
            chunks_count = _ingest_document(client_id, file_name, full_raw_text, pages_data, bot_id=bot_id)
            
            if chunks_count > 0:
                processed_count += 1
            
            # Move to archive regardless of skip/process
            move_to_archive(file_path, file_name)

        except Exception as e:
            logger.error(f"Error processing {file_name}: {e}")

    logger.info(f"Folder ingestion complete! Processed {processed_count} files.")
    return processed_count


def run_web_ingestion(client_id: int, url: str, content: str, bot_id: int = None) -> int:
    """
    Ingest content from a URL for a specific client.
    Supports bot_id for multi-bot architecture.
    """
    logger.info(f"Processing URL: {url} for client {client_id}, bot {bot_id}")

    try:
        # Wrap content in the expected format for chunking
        # We treat the whole page as a single "page" of text
        pages_data = [{
            "text": content,
            "metadata": {"page": 1, "url": url}
        }]

        chunks_count = _ingest_document(client_id, url, content, pages_data, bot_id=bot_id)
        logger.info(f"Web ingestion complete for {url}. Chunks: {chunks_count}")
        return chunks_count
        
    except Exception as e:
        logger.error(f"Error processing URL {url}: {e}")
        raise e

def move_to_archive(file_path: str, filename: str):
    """
    Move a file to the archive directory. 
    If a file with the same name exists, append a timestamp to avoid collision.
    """
    dest_path = os.path.join(ARCHIVE_DIR, filename)
    
    if os.path.exists(dest_path):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        name, ext = os.path.splitext(filename)
        dest_path = os.path.join(ARCHIVE_DIR, f"{name}_{timestamp}{ext}")
    
    try:
        shutil.move(file_path, dest_path)
        logger.info(f"Archived file to: {dest_path}")
    except Exception as e:
        logger.error(f"Failed to archive {filename}: {e}")
