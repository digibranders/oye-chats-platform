import sqlalchemy
from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    api_key = Column(String, unique=True, index=True, nullable=False)
    is_superadmin = Column(sqlalchemy.Boolean, default=False, nullable=False)
    max_bots = Column(Integer, default=1, server_default="1", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # ── LEGACY columns kept for backward compatibility during migration ──
    # These will be removed once all data is migrated to Bot model.
    system_prompt = Column(Text, nullable=True)
    website = Column(String, nullable=True)
    bot_name = Column(String, default="AI Assistant")
    bot_logo = Column(Text, nullable=True)
    launcher_name = Column(String, default="Have Questions?")
    launcher_logo = Column(Text, nullable=True)
    primary_color = Column(String, default="#ba68c8")
    background_color = Column(String, default="#ffffff")
    header_color = Column(String, default="#3A0CA3")
    recommended_colors = Column(JSONB, nullable=True)

    # Relationships
    bots = relationship("Bot", back_populates="client", cascade="all, delete-orphan")
    # Legacy relationships — kept until migration removes client_id from these tables
    documents = relationship(
        "Document", back_populates="client", cascade="all, delete-orphan", foreign_keys="Document.client_id"
    )
    chat_sessions = relationship(
        "ChatSession", back_populates="client", cascade="all, delete-orphan", foreign_keys="ChatSession.client_id"
    )


class Bot(Base):
    """
    Each Bot is an independent chatbot instance owned by a Client.
    Has its own knowledge base, settings, embed key, and chat sessions.
    """

    __tablename__ = "bots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    bot_key = Column(String, unique=True, index=True, nullable=False)  # Public embed key e.g. "bot-a1b2c3d4"

    # Settings (moved from Client)
    name = Column(String, default="AI Assistant", server_default="AI Assistant")
    system_prompt = Column(Text, nullable=True)
    website = Column(String, nullable=True)
    bot_logo = Column(Text, nullable=True)
    launcher_name = Column(String, default="Have Questions?", server_default="Have Questions?")
    launcher_logo = Column(Text, nullable=True)
    primary_color = Column(String, default="#ba68c8", server_default="#ba68c8")
    background_color = Column(String, default="#ffffff", server_default="#ffffff")
    header_color = Column(String, default="#3A0CA3", server_default="#3A0CA3")
    recommended_colors = Column(JSONB, nullable=True)

    bant_enabled = Column(sqlalchemy.Boolean, default=True, server_default="true", nullable=False)
    avatar_type = Column(String, default="upload", server_default="upload", nullable=False)
    orb_color = Column(String, nullable=True)

    # Lead capture form settings
    lead_form_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    lead_form_fields = Column(JSONB, nullable=True)  # e.g. [{"field":"name","required":true}]

    # Email notification settings
    notification_email = Column(String, nullable=True)
    email_on_qualified = Column(Boolean, default=True, server_default="true", nullable=False)
    email_on_handoff = Column(Boolean, default=True, server_default="true", nullable=False)

    # Live chat settings
    agent_timeout_seconds = Column(Integer, default=120, server_default="120", nullable=False)

    is_active = Column(sqlalchemy.Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    client = relationship("Client", back_populates="bots")
    documents = relationship("Document", back_populates="bot", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="bot", cascade="all, delete-orphan")
    lead_infos = relationship("LeadInfo", back_populates="bot", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Legacy FK — kept during migration transition
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True)
    # New FK — primary association
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=True)

    document_name = Column(String, nullable=False)
    file_hash = Column(String, index=True, nullable=False)
    content = Column(Text, nullable=False)
    metadata_info = Column(JSONB, nullable=True)
    embedding = Column(Vector(384), nullable=False)
    search_vector = Column(TSVECTOR)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client", back_populates="documents", foreign_keys=[client_id])
    bot = relationship("Bot", back_populates="documents")

    __table_args__ = (Index("ix_documents_search_vector", "search_vector", postgresql_using="gin"),)


class LeadInfo(Base):
    """Captured lead contact information from pre-chat forms or handoff forms."""

    __tablename__ = "lead_info"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), unique=True, nullable=False)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    company = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="lead_info")
    bot = relationship("Bot", back_populates="lead_infos")


class ChatSession(Base):
    __tablename__ = "chat_sessions"
    id = Column(String, primary_key=True)
    # Legacy FK — kept during migration transition
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True)
    # New FK — primary association
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=True)

    location = Column(String, nullable=True)
    device = Column(String, nullable=True)

    # BANT Qualification State
    bant_need = Column(Text, nullable=True)
    bant_timeline = Column(String, nullable=True)
    bant_authority = Column(String, nullable=True)
    bant_budget = Column(String, nullable=True)

    # Live chat state
    status = Column(String, default="bot", server_default="bot", nullable=False)  # bot|waiting|live|closed
    assigned_agent_id = Column(Integer, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True)
    handoff_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    last_active_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    client = relationship("Client", back_populates="chat_sessions", foreign_keys=[client_id])
    bot = relationship("Bot", back_populates="chat_sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    lead_info = relationship("LeadInfo", back_populates="session", uselist=False, cascade="all, delete-orphan")
    assigned_agent = relationship("Agent", back_populates="active_sessions")


class Agent(Base):
    """Live chat agent — a team member who can handle customer conversations."""

    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False)
    is_online = Column(Boolean, default=False, server_default="false", nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client")
    active_sessions = relationship("ChatSession", back_populates="assigned_agent")


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)  # user|bot|agent|system
    content = Column(Text, nullable=False)
    feedback = Column(Integer, nullable=True)
    trace_id = Column(String(255), nullable=True)  # Langfuse trace ID for feedback linking
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="messages")
