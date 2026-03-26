import os
import shutil
import logging
from typing import List, Optional

from fastapi import APIRouter, UploadFile, File, HTTPException, Request, Depends, Query

from app.db.session import get_session
from app.db.models import Client, Bot, Document
from app.db.repository import get_ingested_documents
from app.config import DOCUMENTS_DIR
from app.api.auth import get_current_client
from app.schemas.client import CrawlRequest
from app.services.crawler_service import crawl_website
from app.ingestion.pipeline import run_folder_ingestion, run_web_ingestion

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"])


@router.get("/documents")
def get_documents_endpoint(bot_id: Optional[int] = Query(None), client: Client = Depends(get_current_client)):
    """Retrieve a list of all ingested documents for the authenticated client."""
    try:
        with get_session() as session:
            docs = get_ingested_documents(session, client_id=client.id, bot_id=bot_id)
            return docs
    except Exception as e:
        logger.error(f"Failed to fetch documents: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/documents/{document_name:path}")
def delete_document_endpoint(
    document_name: str,
    bot_id: Optional[int] = Query(None),
    client: Client = Depends(get_current_client),
):
    """Delete all documents associated with a document name for the authenticated client."""
    logger.info(f"Deletion request for client {client.id}, bot_id={bot_id}, source: {document_name}")
    try:
        from sqlalchemy import func

        with get_session() as session:
            pattern = func.coalesce(
                func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""),
                Document.document_name,
            )

            base_filter = [pattern == document_name]
            if bot_id:
                base_filter.append(Document.bot_id == bot_id)
            else:
                base_filter.append(Document.client_id == client.id)

            deleted_count = session.query(Document).filter(*base_filter).delete(synchronize_session=False)
            session.commit()
            logger.info(f"Deleted {deleted_count} records for Source: {document_name}")

            if deleted_count == 0:
                fallback_filter = [Document.document_name == document_name]
                if bot_id:
                    fallback_filter.append(Document.bot_id == bot_id)
                else:
                    fallback_filter.append(Document.client_id == client.id)
                deleted_count = session.query(Document).filter(*fallback_filter).delete(synchronize_session=False)
                session.commit()

            if deleted_count == 0:
                raise HTTPException(status_code=404, detail=f"Source '{document_name}' not found.")

            file_path = os.path.join(DOCUMENTS_DIR, document_name)
            if os.path.exists(file_path):
                os.remove(file_path)
                logger.info(f"Deleted file from disk: {file_path}")

            logger.info(f"Deleted {deleted_count} chunks for document '{document_name}' (client {client.id})")
            return {"message": f"Successfully deleted '{document_name}'", "chunks_removed": deleted_count}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete document '{document_name}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ingest")
def ingest_documents(
    files: List[UploadFile] = File(...),
    bot_id: Optional[int] = Query(None),
    client: Client = Depends(get_current_client),
):
    """Ingest multiple files (PDF, DOCX, TXT, MD) for a client."""
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    supported_extensions = [".pdf", ".docx", ".txt", ".md"]
    saved_files = []

    for file in files:
        if not any(file.filename.lower().endswith(ext) for ext in supported_extensions):
            logger.warning(f"Skipping unsupported file: {file.filename}")
            continue

        file_path = os.path.join(DOCUMENTS_DIR, file.filename)

        try:
            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
            saved_files.append(file.filename)
            logger.info(f"Saved file: {file.filename}")
        except Exception as e:
            logger.error(f"Failed to save {file.filename}: {e}")

    if not saved_files:
        raise HTTPException(status_code=400, detail="No valid files (PDF, DOCX, TXT, MD) saved.")

    try:
        logger.info(f"Starting ingestion for {len(saved_files)} files for client {client.id}, bot_id={bot_id}...")
        count = run_folder_ingestion(client.id, DOCUMENTS_DIR, bot_id=bot_id)
        return {
            "message": "Ingestion completed successfully",
            "files_uploaded": saved_files,
            "documents_processed_count": count,
        }
    except Exception as e:
        logger.error(f"Ingestion failed: {e}")
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")


@router.post("/crawl")
async def crawl_endpoint(
    request: CrawlRequest,
    bot_id: Optional[int] = Query(None),
    client: Client = Depends(get_current_client),
):
    """Crawl a URL recursively and ingest content for a client."""
    try:
        logger.info(f"Crawling URL recursively: {request.url} for client {client.id}, bot_id={bot_id}")
        crawl_data = await crawl_website(request.url)

        results = crawl_data.get("results")
        recommended_colors = crawl_data.get("recommended_colors", [])

        if not results:
            raise HTTPException(status_code=400, detail="Failed to retrieve content from URL")

        total_chunks = 0
        pages_processed = 0

        for page in results:
            url = page.get("url")
            content = page.get("content")
            if url and content:
                logger.info(f"Ingesting: {url}")
                chunks = run_web_ingestion(client.id, url, content, bot_id=bot_id)
                total_chunks += chunks
                pages_processed += 1

        if recommended_colors:
            with get_session() as session:
                if bot_id:
                    bot_db = session.query(Bot).get(bot_id)
                    if bot_db and bot_db.client_id == client.id:
                        bot_db.recommended_colors = recommended_colors
                        session.commit()
                        logger.info(f"Saved {len(recommended_colors)} recommended colors for bot {bot_id}")
                else:
                    client_db = session.query(Client).get(client.id)
                    if client_db:
                        client_db.recommended_colors = recommended_colors
                        session.commit()
                        logger.info(f"Saved {len(recommended_colors)} recommended colors for client {client.id}")

        return {
            "message": "Crawling and ingestion completed successfully",
            "root_url": request.url,
            "pages_processed": pages_processed,
            "chunks_processed": total_chunks,
            "recommended_colors": recommended_colors,
        }
    except Exception as e:
        logger.error(f"Crawling failed: {e}")
        raise HTTPException(status_code=500, detail=f"Crawling failed: {str(e)}")
