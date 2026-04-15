import sqlalchemy
from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    company_name = Column(String, nullable=True)
    hashed_password = Column(String, nullable=False)
    api_key = Column(String, unique=True, index=True, nullable=False)
    is_superadmin = Column(sqlalchemy.Boolean, default=False, nullable=False)
    max_bots = Column(Integer, default=100, server_default="100", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Password reset fields
    reset_otp = Column(String, nullable=True)
    reset_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

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
    brand_tone = Column(Text, nullable=True)  # Auto-extracted or manually set brand voice/tone description
    company_name = Column(String, nullable=True)  # Auto-extracted or manually set company/brand name
    company_description = Column(Text, nullable=True)  # Auto-extracted or manually set company description
    website = Column(String, nullable=True)
    bot_logo = Column(Text, nullable=True)
    launcher_name = Column(String, default="Have Questions?", server_default="Have Questions?")
    launcher_logo = Column(Text, nullable=True)
    primary_color = Column(String, default="#ba68c8", server_default="#ba68c8")
    background_color = Column(String, default="#ffffff", server_default="#ffffff")
    header_color = Column(String, default="#3A0CA3", server_default="#3A0CA3")
    recommended_colors = Column(JSONB, nullable=True)
    user_bubble_color = Column(String, default="#DBE9FF", server_default="#DBE9FF")

    bant_enabled = Column(sqlalchemy.Boolean, default=True, server_default="true", nullable=False)
    bant_config = Column(JSONB, nullable=True)  # per-bot qualification rubric config
    avatar_type = Column(String, default="upload", server_default="upload", nullable=False)
    orb_color = Column(String, nullable=True)

    # Lead capture form settings
    lead_form_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    lead_form_fields = Column(JSONB, nullable=True)  # e.g. [{"field":"name","required":true}]

    # Email notification settings
    notification_email = Column(String, nullable=True)  # Legacy single recipient (kept for backward compat)
    notification_emails = Column(
        JSONB, nullable=True
    )  # Per-event routing: {"default": [...], "qualified_lead": [...], ...}
    reply_to_email = Column(String, nullable=True)  # Reply-To header for branded "via OyeChats" emails
    email_on_qualified = Column(Boolean, default=True, server_default="true", nullable=False)
    email_on_handoff = Column(Boolean, default=True, server_default="true", nullable=False)
    email_on_offline = Column(Boolean, default=True, server_default="true", nullable=False)
    email_visitor_confirmation = Column(Boolean, default=True, server_default="true", nullable=False)

    # Live chat settings
    live_chat_enabled = Column(Boolean, default=True, server_default="true", nullable=False)
    operator_timeout_seconds = Column(Integer, default=120, server_default="120", nullable=False)
    # Configurable timeouts for visitor/operator disconnect grace periods
    visitor_disconnect_timeout = Column(Integer, default=120, server_default="120", nullable=False)
    operator_disconnect_timeout = Column(Integer, default=60, server_default="60", nullable=False)
    business_hours = Column(sqlalchemy.JSON, nullable=True)  # e.g. {"mon":{"start":"09:00","end":"17:00"}, ...}

    # Configurable messages shown to visitors (admin-editable from the Live Chat settings tab)
    welcome_title = Column(String, default="Hi there 👋", server_default="Hi there 👋", nullable=False)
    welcome_subtitle = Column(
        String, default="How can we help you today?", server_default="How can we help you today?", nullable=False
    )
    waiting_message = Column(
        String, default="Connecting you to support...", server_default="Connecting you to support...", nullable=False
    )
    offline_message = Column(
        String,
        default="Our team is currently unavailable.",
        server_default="Our team is currently unavailable.",
        nullable=False,
    )
    # Delay (seconds) before handoff form auto-appears after the bot suggests a handoff.
    # 0 = show immediately; useful to give the visitor time to read the bot's last response.
    handoff_delay_seconds = Column(Integer, default=0, server_default="0", nullable=False)
    calendly_url = Column(String, nullable=True)
    meeting_booking_enabled = Column(Boolean, default=False, server_default="false", nullable=False)

    # Feature flags — controls per-bot widget/operator behavior toggles
    feature_flags = Column(
        JSONB,
        nullable=False,
        server_default='{"file_sharing": false, "post_chat_rating": true, "show_branding": true, "queue_position": false, "typing_preview": true, "email_transcript": false}',
    )

    # Widget messages — all customizable user-facing strings (welcome, chat input, error messages, etc.)
    widget_messages = Column(
        JSONB,
        nullable=False,
        server_default='{"welcome_greeting": "Hi There, How can I help you today?", "welcome_suggestions": ["Our Services", "About us", "Contact us"], "input_placeholder": "Write a message...", "live_chat_label": "Live chat", "greeting_message": "Hi! Let us know if you have any questions.", "offline_message": "Team is currently unavailable", "rating_prompt": "How was your experience?", "end_chat_label": "End chat and return to AI"}',
    )

    # Widget configuration — timing, thresholds, and advanced settings
    widget_config = Column(
        JSONB,
        nullable=False,
        server_default='{"welcome_exit_duration_ms": 350, "greeting_delay_ms": 3000, "typing_timeout_ms": 2000, "frustration_window_ms": 30000, "frustration_threshold_messages": 3, "max_reconnect_attempts": 15, "max_reconnect_delay_ms": 30000, "heartbeat_visible_ms": 25000, "heartbeat_hidden_ms": 50000, "handoff_auto_submit_delay_ms": 300}',
    )

    # Widget branding — customizable branding text and URL
    branding_text = Column(String, default="Powered by OyeChats", server_default="Powered by OyeChats", nullable=False)
    branding_url = Column(String, default="https://oyechats.com", server_default="https://oyechats.com", nullable=False)

    is_active = Column(sqlalchemy.Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    client = relationship("Client", back_populates="bots")
    documents = relationship("Document", back_populates="bot", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="bot", cascade="all, delete-orphan")
    lead_infos = relationship("LeadInfo", back_populates="bot", cascade="all, delete-orphan")
    growth_events = relationship("BotGrowthEvent", back_populates="bot", cascade="all, delete-orphan")
    webhooks = relationship("Webhook", back_populates="bot", cascade="all, delete-orphan")
    meeting_bookings = relationship("MeetingBooking", back_populates="bot", cascade="all, delete-orphan")


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
    embedding = Column(Vector(1536), nullable=False)
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

    # Behavioral scoring
    behavioral_score = Column(Integer, default=0, server_default="0", nullable=False)
    page_url = Column(String, nullable=True)
    referrer = Column(String, nullable=True)
    utm_params = Column(JSONB, nullable=True)
    visit_count = Column(Integer, default=1, server_default="1", nullable=False)

    # BANT Qualification State
    bant_need = Column(Text, nullable=True)
    bant_timeline = Column(String, nullable=True)
    bant_authority = Column(String, nullable=True)
    bant_budget = Column(String, nullable=True)
    bant_need_score = Column(Integer, default=0, server_default="0", nullable=False)
    bant_budget_score = Column(Integer, default=0, server_default="0", nullable=False)
    bant_authority_score = Column(Integer, default=0, server_default="0", nullable=False)
    bant_timeline_score = Column(Integer, default=0, server_default="0", nullable=False)
    bant_score = Column(Integer, default=0, server_default="0", nullable=False)  # composite 0-100
    bant_tier = Column(String, default="unqualified", server_default="unqualified", nullable=False)
    dimensions_assessed = Column(Integer, default=0, server_default="0", nullable=False)
    bant_last_updated = Column(DateTime(timezone=True), nullable=True)
    dimension_scores = Column(JSONB, nullable=True)
    qualification_framework = Column(String, default="bant", server_default="bant", nullable=False)

    # Live chat state
    status = Column(String, default="bot", server_default="bot", nullable=False)  # bot|waiting|live|closed
    assigned_operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)
    handoff_reason = Column(Text, nullable=True)
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)
    visitor_metadata = Column(JSONB, nullable=True)  # parsed user-agent: browser, os, etc.
    visitor_rating = Column(Integer, nullable=True)  # Post-chat satisfaction: 1–5, null = not rated
    visitor_resolved = Column(Boolean, nullable=True)  # Post-chat: was the issue resolved? null = not answered

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    last_active_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    client = relationship("Client", back_populates="chat_sessions", foreign_keys=[client_id])
    bot = relationship("Bot", back_populates="chat_sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    lead_info = relationship("LeadInfo", back_populates="session", uselist=False, cascade="all, delete-orphan")
    assigned_operator = relationship("Operator", back_populates="active_sessions")
    bant_signals = relationship("BANTSignal", back_populates="session", cascade="all, delete-orphan")
    visitor_events = relationship("VisitorEvent", back_populates="session", cascade="all, delete-orphan")


class BANTSignal(Base):
    __tablename__ = "bant_signals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = Column(Integer, ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True)
    dimension = Column(String, nullable=False)  # budget|authority|need|timeline
    signal_text = Column(Text, nullable=False)
    extracted_value = Column(Text, nullable=True)
    confidence = Column(String, default="medium", server_default="medium", nullable=False)
    score_before = Column(Integer, default=0, server_default="0", nullable=False)
    score_after = Column(Integer, default=0, server_default="0", nullable=False)
    source = Column(String, default="llm", server_default="llm", nullable=False)  # llm|cta_click
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="bant_signals")


class VisitorEvent(Base):
    """Behavioral events tracked from the widget (page views, UTM captures, return visits, etc.)."""

    __tablename__ = "visitor_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False)
    event_type = Column(String, nullable=False)  # page_view|return_visit|utm_captured|time_on_site
    event_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="visitor_events")
    bot = relationship("Bot")


class BotGrowthEvent(Base):
    """Minimal growth event log for tracking public demo-link distribution."""

    __tablename__ = "bot_growth_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    bot = relationship("Bot", back_populates="growth_events")

    __table_args__ = (
        CheckConstraint(
            "event_type IN ('demo_share_clicked', 'demo_link_opened')",
            name="ck_bot_growth_events_event_type",
        ),
    )


class Webhook(Base):
    __tablename__ = "webhooks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False, index=True)
    url = Column(String, nullable=False)
    secret = Column(String, nullable=False)
    events = Column(JSONB, default=list, server_default="[]", nullable=False)
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    bot = relationship("Bot", back_populates="webhooks")
    deliveries = relationship("WebhookDelivery", back_populates="webhook", cascade="all, delete-orphan")


class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    webhook_id = Column(Integer, ForeignKey("webhooks.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String, nullable=False)
    payload = Column(JSONB, nullable=False)
    status_code = Column(Integer, nullable=True)
    response_body = Column(Text, nullable=True)
    attempt = Column(Integer, default=1, server_default="1", nullable=False)
    next_retry_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    delivered_at = Column(DateTime(timezone=True), nullable=True)

    webhook = relationship("Webhook", back_populates="deliveries")


class MeetingBooking(Base):
    __tablename__ = "meeting_bookings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False)
    booking_url = Column(String, nullable=True)
    meeting_time = Column(DateTime(timezone=True), nullable=True)
    attendee_email = Column(String, nullable=True)
    status = Column(String, default="scheduled", server_default="scheduled", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession")
    bot = relationship("Bot", back_populates="meeting_bookings")


class Department(Base):
    """Department grouping for operators (e.g. Sales, Support, Billing)."""

    __tablename__ = "departments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client")
    operators = relationship("Operator", back_populates="department")


class Operator(Base):
    """Live chat operator — a team member who can handle customer conversations."""

    __tablename__ = "operators"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False)
    is_online = Column(Boolean, default=False, server_default="false", nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Auth credentials (for separate operator login)
    hashed_password = Column(String, nullable=True)
    operator_api_key = Column(String, unique=True, index=True, nullable=True)

    # Role & department
    role = Column(String, default="operator", server_default="operator", nullable=False)  # owner|admin|operator
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)

    # Profile & settings
    avatar_url = Column(String, nullable=True)
    max_concurrent_chats = Column(Integer, default=5, server_default="5", nullable=False)
    notification_preferences = Column(JSONB, nullable=True)

    client = relationship("Client")
    department = relationship("Department", back_populates="operators")
    active_sessions = relationship("ChatSession", back_populates="assigned_operator")


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)  # user|bot|operator|system
    content = Column(Text, nullable=False)
    feedback = Column(Integer, nullable=True)
    trace_id = Column(String(255), nullable=True)  # Langfuse trace ID for feedback linking
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="messages")


class OfflineMessage(Base):
    """Message left by a visitor when no operator is available."""

    __tablename__ = "offline_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="SET NULL"), nullable=True)
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)
    visitor_name = Column(String, nullable=False)
    visitor_email = Column(String, nullable=False)
    visitor_phone = Column(String, nullable=True)
    message_body = Column(Text, nullable=False)
    status = Column(String, default="new", server_default="new", nullable=False)  # new|read|replied
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    read_at = Column(DateTime(timezone=True), nullable=True)
    replied_at = Column(DateTime(timezone=True), nullable=True)

    bot = relationship("Bot")


class ChatAuditLog(Base):
    """Audit trail for live chat state transitions (accept, close, transfer, etc.)."""

    __tablename__ = "chat_audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)
    action = Column(String, nullable=False)  # handoff_requested|accepted|closed|transferred|timeout|visitor_ended
    details = Column(JSONB, nullable=True)  # e.g. {"transferred_to": 5, "reason": "billing question"}
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession")
    operator = relationship("Operator")


class CannedResponse(Base):
    """Pre-saved quick replies for operators."""

    __tablename__ = "canned_responses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    shortcut = Column(String, nullable=True)  # e.g. "/hello"
    category = Column(String, nullable=True)
    created_by_operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    client = relationship("Client")


# ── Pricing, Subscriptions & Billing ──────────────────────────────────────────


class Plan(Base):
    """Pricing plan tier — fully configurable from the super admin panel."""

    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)  # "Free", "Starter", "Standard", "Enterprise"
    slug = Column(String, unique=True, index=True, nullable=False)  # "free", "starter", "standard", "enterprise"
    description = Column(Text, nullable=True)

    # Pricing (stored in cents to avoid floating-point issues)
    pricing_model = Column(
        String, default="per_operator", server_default="per_operator", nullable=False
    )  # per_operator|flat|custom
    monthly_price_cents = Column(Integer, default=0, server_default="0", nullable=False)
    annual_price_cents = Column(Integer, default=0, server_default="0", nullable=False)  # total annual price
    annual_discount_percent = Column(Integer, default=30, server_default="30", nullable=False)

    # Trial
    trial_days = Column(Integer, default=14, server_default="14", nullable=False)

    # Usage limits — JSONB allows flexible addition of new limit types without migrations
    limits = Column(
        JSONB,
        nullable=False,
        server_default='{"ai_messages": 250, "url_scans": 50, "live_chat_messages": 0, "email_summaries": 0, "email_notifications": 0, "knowledge_pages": 50, "storage_mb": 5, "chat_history_days": 7}',
    )

    # Feature flags — which features are available on this plan
    features = Column(
        JSONB,
        nullable=False,
        server_default='{"live_chat": false, "bant": false, "branding_removable": false, "api_access": false, "webhooks": false, "sso": false, "advanced_analytics": false, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
    )

    # Overage pricing (cents per AI message beyond limit; 0 = hard cutoff)
    overage_rate_cents = Column(Integer, default=0, server_default="0", nullable=False)

    # Stripe integration
    stripe_product_id = Column(String, nullable=True)
    stripe_monthly_price_id = Column(String, nullable=True)
    stripe_annual_price_id = Column(String, nullable=True)

    # Razorpay integration
    razorpay_plan_id_monthly = Column(String, nullable=True)
    razorpay_plan_id_annual = Column(String, nullable=True)

    # Display & ordering
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    is_default = Column(Boolean, default=False, server_default="false", nullable=False)  # auto-assigned to new clients
    sort_order = Column(Integer, default=0, server_default="0", nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    subscriptions = relationship("Subscription", back_populates="plan")


class Subscription(Base):
    """Links a Client to a Plan — tracks billing state and payment provider details."""

    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False)

    # Subscription state
    status = Column(
        String, default="trialing", server_default="trialing", nullable=False
    )  # trialing|active|past_due|canceled|paused|expired
    billing_cycle = Column(String, default="monthly", server_default="monthly", nullable=False)  # monthly|annual
    operator_quantity = Column(Integer, default=1, server_default="1", nullable=False)  # for per-operator pricing

    # Billing period
    current_period_start = Column(DateTime(timezone=True), nullable=True)
    current_period_end = Column(DateTime(timezone=True), nullable=True)

    # Trial tracking
    trial_start = Column(DateTime(timezone=True), nullable=True)
    trial_end = Column(DateTime(timezone=True), nullable=True)

    # Cancellation
    canceled_at = Column(DateTime(timezone=True), nullable=True)
    cancel_reason = Column(Text, nullable=True)
    cancel_at_period_end = Column(Boolean, default=False, server_default="false", nullable=False)

    # Payment provider IDs
    payment_provider = Column(
        String, default="stripe", server_default="stripe", nullable=False
    )  # stripe|razorpay|manual
    stripe_subscription_id = Column(String, unique=True, index=True, nullable=True)
    stripe_customer_id = Column(String, index=True, nullable=True)
    razorpay_subscription_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_customer_id = Column(String, index=True, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    client = relationship("Client", backref="subscriptions")
    plan = relationship("Plan", back_populates="subscriptions")
    invoices = relationship("Invoice", back_populates="subscription", cascade="all, delete-orphan")

    __table_args__ = (
        # Only one active/trialing subscription per client
        Index(
            "ix_subscriptions_client_active",
            "client_id",
            unique=True,
            postgresql_where=sqlalchemy.text("status IN ('active', 'trialing', 'past_due')"),
        ),
    )


class UsageRecord(Base):
    """Monthly usage tracking per client — reset at the start of each billing period."""

    __tablename__ = "usage_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)

    # Billing period this record covers
    period_start = Column(DateTime(timezone=True), nullable=False)
    period_end = Column(DateTime(timezone=True), nullable=False)

    # Usage counters
    ai_messages_used = Column(Integer, default=0, server_default="0", nullable=False)
    ai_messages_limit = Column(Integer, default=0, server_default="0", nullable=False)
    live_chat_messages_used = Column(Integer, default=0, server_default="0", nullable=False)
    live_chat_messages_limit = Column(Integer, default=0, server_default="0", nullable=False)
    url_scans_used = Column(Integer, default=0, server_default="0", nullable=False)
    url_scans_limit = Column(Integer, default=0, server_default="0", nullable=False)
    email_summaries_used = Column(Integer, default=0, server_default="0", nullable=False)
    email_summaries_limit = Column(Integer, default=0, server_default="0", nullable=False)
    email_notifications_used = Column(Integer, default=0, server_default="0", nullable=False)
    email_notifications_limit = Column(Integer, default=0, server_default="0", nullable=False)

    # Snapshot counters (current totals, not per-period)
    bots_count = Column(Integer, default=0, server_default="0", nullable=False)
    operators_count = Column(Integer, default=0, server_default="0", nullable=False)
    storage_used_mb = Column(Integer, default=0, server_default="0", nullable=False)
    storage_limit_mb = Column(Integer, default=0, server_default="0", nullable=False)

    # Overage tracking
    overage_messages = Column(Integer, default=0, server_default="0", nullable=False)
    overage_amount_cents = Column(Integer, default=0, server_default="0", nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    client = relationship("Client")
    plan = relationship("Plan")

    __table_args__ = (
        # One usage record per client per billing period
        Index("ix_usage_records_client_period", "client_id", "period_start", unique=True),
    )


class Invoice(Base):
    """Payment history — synced from Stripe/Razorpay via webhooks."""

    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True)

    # Amount
    amount_cents = Column(Integer, nullable=False)
    currency = Column(String, default="usd", server_default="usd", nullable=False)
    status = Column(String, default="pending", server_default="pending", nullable=False)  # paid|pending|failed|refunded

    # Provider references
    stripe_invoice_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_payment_id = Column(String, unique=True, index=True, nullable=True)

    # Links
    invoice_url = Column(String, nullable=True)  # Hosted invoice page URL
    pdf_url = Column(String, nullable=True)  # PDF download URL

    # Billing period this invoice covers
    period_start = Column(DateTime(timezone=True), nullable=True)
    period_end = Column(DateTime(timezone=True), nullable=True)

    # Description for line items (e.g. "Starter Plan - Monthly" or "Overage: 500 messages")
    description = Column(Text, nullable=True)

    paid_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client")
    subscription = relationship("Subscription", back_populates="invoices")


class PaymentMethod(Base):
    """Stored payment methods for a client — synced from Stripe/Razorpay."""

    __tablename__ = "payment_methods"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    # Provider
    provider = Column(String, nullable=False)  # stripe|razorpay
    type = Column(String, nullable=False)  # card|upi|bank
    last4 = Column(String(4), nullable=True)
    brand = Column(String, nullable=True)  # visa|mastercard|amex|etc
    expiry_month = Column(Integer, nullable=True)
    expiry_year = Column(Integer, nullable=True)

    is_default = Column(Boolean, default=False, server_default="false", nullable=False)

    # Provider references
    stripe_payment_method_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_token_id = Column(String, unique=True, index=True, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client")
