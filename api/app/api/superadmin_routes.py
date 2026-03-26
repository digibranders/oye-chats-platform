from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func
from app.db.session import get_session
from app.db.models import Client, ChatSession, ChatMessage, Bot, Document
from app.api.auth import get_superadmin
from app.core.security import get_password_hash
import uuid
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin"])

class CreateClientRequest(BaseModel):
    name: str
    email: str
    password: str
    website: str | None = None

@router.post("/clients")
def create_client(request: CreateClientRequest, superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Create a new Client account.
    Client will create their own bots from the dashboard.
    """
    with get_session() as session:
        # Check if email exists
        stmt = select(Client).where(Client.email == request.email).limit(1)
        existing = session.execute(stmt).scalars().first()
        if existing:
            raise HTTPException(status_code=400, detail="A client with this email already exists.")

        new_client = Client(
            name=request.name,
            email=request.email,
            hashed_password=get_password_hash(request.password),
            api_key=str(uuid.uuid4().hex),
            website=request.website,
            is_superadmin=False
        )

        session.add(new_client)
        session.commit()
        session.refresh(new_client)

        logger.info(f"Superadmin {superadmin.id} created new client {new_client.id} ({new_client.name})")

        return {
            "message": "Client created successfully",
            "client_id": new_client.id,
            "api_key": new_client.api_key,
        }


@router.delete("/clients/{client_id}")
def delete_client(client_id: int, superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Delete a client and ALL their data (bots, documents, sessions, messages).
    Cannot delete yourself (the superadmin account).
    """
    with get_session() as session:
        stmt = select(Client).where(Client.id == client_id)
        client = session.execute(stmt).scalars().first()

        if not client:
            raise HTTPException(status_code=404, detail="Client not found.")

        # Prevent superadmin from deleting themselves
        if client.id == superadmin.id:
            raise HTTPException(status_code=400, detail="You cannot delete your own account.")

        # Prevent deleting other superadmins
        if client.is_superadmin:
            raise HTTPException(status_code=400, detail="Cannot delete a superadmin account.")

        client_name = client.name
        client_email = client.email

        # Delete the client — CASCADE will remove all bots, documents, sessions, messages
        session.delete(client)
        session.commit()

        logger.info(f"Superadmin {superadmin.id} deleted client {client_id} ({client_name}, {client_email})")

        return {
            "message": f"Client '{client_name}' and all associated data deleted successfully.",
            "deleted_client_id": client_id,
        }

@router.get("/clients")
def list_clients(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get all clients on the platform.
    """
    with get_session() as session:
        stmt = select(Client).order_by(Client.created_at.desc())
        clients = session.execute(stmt).scalars().all()
        
        return [{
            "id": c.id,
            "name": c.name,
            "email": c.email,
            "is_superadmin": c.is_superadmin,
            "website": c.website,
            "api_key": c.api_key,
            "created_at": c.created_at.isoformat() if c.created_at else None
        } for c in clients]

@router.get("/stats")
def get_global_stats(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get aggregate global usage stats (Total Clients, Total Messages).
    """
    with get_session() as session:
        total_clients = session.execute(select(func.count(Client.id))).scalar() or 0
        total_messages = session.execute(select(func.count(ChatMessage.id))).scalar() or 0
        total_sessions = session.execute(select(func.count(ChatSession.id))).scalar() or 0
        
        return {
            "total_clients": total_clients,
            "total_messages": total_messages,
            "total_sessions": total_sessions
        }

@router.get("/feedback")
def get_global_feedback(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get all feedback across all clients.
    """
    try:
        from app.db.repository import get_global_feedback_data
        with get_session() as session:
            data = get_global_feedback_data(session)
            
            # Map raw session IDs to chronologically assigned user numbers per client
            session_to_user_map = {}
            client_counters = {}
            
            for item in data:
                sid = item['session_id']
                cid = item['client_name']
                
                if cid not in client_counters:
                    client_counters[cid] = 1
                    
                if sid not in session_to_user_map:
                    session_to_user_map[sid] = f"User {client_counters[cid]}"
                    client_counters[cid] += 1
                
                # Replace the raw UUID with the readable name
                item['user'] = session_to_user_map[sid]
                # Remove raw session_id
                del item['session_id']
                
            # Reverse order to show newest feedback first
            return sorted(data, key=lambda x: x['created_at'], reverse=True)
            
    except Exception as e:
        logger.error(f"Failed to fetch global feedback logs: {e}")
        raise HTTPException(status_code=500, detail=str(e))
