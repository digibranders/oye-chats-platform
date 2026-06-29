import sqlalchemy
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, TSVECTOR
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    company_name = Column(String, nullable=True)
    # Nullable because OAuth-only signups never set a password. The
    # /auth/google/callback path always creates the Client row first and
    # never assigns a hashed_password; password login for that account
    # only becomes possible after a /auth/request-password-reset round
    # trip (forced "set initial password" UX).
    hashed_password = Column(String, nullable=True)
    api_key = Column(String, unique=True, index=True, nullable=False)
    is_superadmin = Column(sqlalchemy.Boolean, default=False, nullable=False)
    superadmin_role = Column(String, nullable=True)  # owner | admin | readonly
    suspended_at = Column(DateTime(timezone=True), nullable=True)
    max_bots = Column(Integer, default=100, server_default="100", nullable=False)
    # Paid bot-seat add-ons purchased on top of the plan's included quota.
    # Effective bot limit is computed in plan_entitlements_service as
    # ``min(plan.limits.bots + extra_bot_seats, plan.limits.max_bots_cap)``.
    # Lives on Client (not Subscription) so a plan change doesn't clobber
    # paid seats — same pattern as max_bots.
    extra_bot_seats = Column(Integer, default=0, server_default="0", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Email OTP verification
    is_verified = Column(Boolean, default=False, nullable=False, server_default="false")
    email_otp = Column(String, nullable=True)
    email_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

    # Password reset fields
    reset_otp = Column(String, nullable=True)
    reset_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

    # ── Affiliate program v1 (referral attribution) ──
    # First-touch attribution: set once at signup if a valid ?ref=code cookie
    # is present, then immutable. ``referral_code_id`` is FK to referral_codes.
    referral_code_id = Column(
        Integer,
        ForeignKey("referral_codes.id", ondelete="SET NULL"),
        nullable=True,
    )
    referral_attributed_at = Column(DateTime(timezone=True), nullable=True)

    # Set when the trial hard-delete cron purges the workspace after the
    # 15-day retention window. Stamped Client rows still exist for
    # support / audit but no longer count as "active customers".
    deactivated_at = Column(DateTime(timezone=True), nullable=True)

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
    # Affiliate membership (0..1). Derived ``is_affiliate`` reads this — the
    # ``affiliates`` row is the single source of truth.
    affiliate = relationship(
        "Affiliate",
        foreign_keys="Affiliate.client_id",
        back_populates="client",
        uselist=False,
        cascade="all, delete-orphan",
    )
    # Captured referral code (first-touch attribution at signup).
    referral_code = relationship(
        "ReferralCode",
        foreign_keys=[referral_code_id],
        lazy="joined",
    )
    # External identity providers linked to this Client (Google, future:
    # GitHub/Microsoft). Cascade-deletes so a workspace teardown also
    # removes the OAuth links — provider rows on Google's side are not
    # affected because we only store the provider's stable subject id.
    oauth_accounts = relationship(
        "OAuthAccount",
        back_populates="client",
        cascade="all, delete-orphan",
    )

    @property
    def is_affiliate(self) -> bool:
        """True iff this client has an active (non-deactivated) affiliate row.

        Derived from the ``affiliate`` relationship — there is no separate
        boolean column, so the relationship is the single source of truth.
        Callers that touch this property must have the ``affiliate`` row
        loaded (eager or via the same session); otherwise it returns False.
        """
        aff = self.affiliate
        return aff is not None and aff.deactivated_at is None


class OAuthAccount(Base):
    """External identity provider link for a Client.

    One row per (provider, provider_user_id) pair. ``provider_user_id`` is
    the provider's stable subject identifier (Google's ``sub`` claim) — never
    the user's email, which can change. Matching by ``provider_user_id`` is
    what lets a returning OAuth user log in even if they later changed their
    Google account's primary email.

    A single Client can have multiple OAuthAccount rows (future: Google +
    GitHub on the same workspace) but only one per provider — enforced by
    the partial unique index on (client_id, provider).
    """

    __tablename__ = "oauth_accounts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider = Column(String, nullable=False)  # "google" (future: "github", "microsoft")
    provider_user_id = Column(String, nullable=False)  # stable provider subject id
    email = Column(String, nullable=True)  # provider-reported email at last login (informational)
    picture_url = Column(Text, nullable=True)  # provider-reported avatar URL (informational)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)

    client = relationship("Client", back_populates="oauth_accounts")

    __table_args__ = (
        # Same provider account can't be linked to two Clients — enforces
        # the "find by provider_user_id" lookup as a true primary key for
        # the OAuth identity.
        Index(
            "ix_oauth_accounts_provider_subject",
            "provider",
            "provider_user_id",
            unique=True,
        ),
        # A Client can only have one row per provider. Future-proofs for
        # multi-provider linking (Google + GitHub on the same account).
        Index(
            "ix_oauth_accounts_client_provider",
            "client_id",
            "provider",
            unique=True,
        ),
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

    # CRAG relevance gate threshold override.
    # NULL = use the env default (RELEVANCE_THRESHOLD, currently 0.55).
    # Lower = more lenient (fewer off-topic refusals, more risk of off-scope answers).
    # Higher = stricter (more refusals, more risk of false positives on legit questions).
    # Reasonable range: 0.40 (lenient) — 0.70 (strict). Out-of-range is clamped at runtime.
    relevance_threshold = Column(Float, nullable=True)
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

    # ── Live chat availability state machine (b1f2a3c4d5e6) ──
    # Routing strategy applied when multiple online operators have capacity.
    # least_busy = fewest active chats wins, ties break by round-robin cursor.
    # round_robin = strict cursor advance regardless of load.
    # first_available = first online+capacity operator returned by the index.
    live_chat_routing_strategy = Column(String, default="least_busy", server_default="least_busy", nullable=False)
    # Seconds a visitor waits in the queue before the widget auto-falls back
    # to the offline message form. Default 20s per product spec.
    live_chat_queue_timeout_seconds = Column(Integer, default=20, server_default="20", nullable=False)
    # Reject queue entries past this cap (returns "queue_full" state).
    live_chat_max_queue_size = Column(Integer, default=10, server_default="10", nullable=False)

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
        default="We'll be right back! Leave a message and we'll follow up shortly.",
        server_default="We'll be right back! Leave a message and we'll follow up shortly.",
        nullable=False,
    )
    # Delay (seconds) before handoff form auto-appears after the bot suggests a handoff.
    # 0 = show immediately; useful to give the visitor time to read the bot's last response.
    handoff_delay_seconds = Column(Integer, default=0, server_default="0", nullable=False)
    calendly_url = Column(String, nullable=True)
    meeting_booking_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    meeting_provider = Column(String, nullable=True)  # "calendly" | "zcal" | null
    zcal_url = Column(String, nullable=True)

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
        server_default='{"welcome_greeting": "Hi There, How can I help you today?", "welcome_suggestions": ["Our Services", "About us", "Contact us"], "input_placeholder": "Write a message...", "live_chat_label": "Live chat", "greeting_message": "Hi! Let us know if you have any questions.", "offline_message": "We\'ll be right back! Leave a message and we\'ll follow up shortly.", "rating_prompt": "How was your experience?", "end_chat_label": "End chat and return to AI"}',
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

    # Service-scoped answers. When ``services`` is non-empty the bot is constrained
    # to only answer about those services. ``services_url`` is appended as a CTA
    # under each on-scope answer (e.g. "Learn more: [Our Services](url)") and
    # auto-suggested from the URL crawl when not set explicitly by the admin.
    services = Column(JSONB, nullable=True)  # list[str] of admin-defined service names
    services_url = Column(String, nullable=True)

    # Widget embed origin restriction. When ``domain_check_enabled`` is true the
    # backend rejects ``X-Bot-Key`` requests whose Origin/Referer hostname does not
    # match an entry in ``allowed_domains``. Entries support exact hostnames
    # (``acme.com``) and wildcard subdomains (``*.acme.com``). Defaults are off +
    # empty so existing bots are unaffected until the customer opts in.
    allowed_domains = Column(
        JSONB,
        nullable=False,
        default=list,
        server_default=sqlalchemy.text("'[]'::jsonb"),
    )
    domain_check_enabled = Column(Boolean, default=False, server_default="false", nullable=False)

    is_active = Column(sqlalchemy.Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # ── Per-bot billing (f8b2c4d6e1a3) ────────────────────────────────────
    # ``plan_id`` and ``subscription_id`` point at the Plan / Subscription
    # funding this specific bot in the per-bot billing model. Both are
    # NULL for the single Free bot and for legacy-pooled bots that were
    # grandfathered at migration time (those keep using the client-level
    # ledger via ``is_legacy_pooled``). ``credits_balance`` is the eagerly
    # maintained running total used by the chat hot path so we don't
    # SUM(credit_ledger) on every deduction.
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="RESTRICT"), nullable=True, index=True)
    subscription_id = Column(
        Integer,
        ForeignKey("subscriptions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    is_legacy_pooled = Column(Boolean, default=False, server_default="false", nullable=False)
    credits_balance = Column(Integer, default=0, server_default="0", nullable=False)

    # Relationships
    client = relationship("Client", back_populates="bots")
    documents = relationship("Document", back_populates="bot", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="bot", cascade="all, delete-orphan")
    lead_infos = relationship("LeadInfo", back_populates="bot", cascade="all, delete-orphan")
    growth_events = relationship("BotGrowthEvent", back_populates="bot", cascade="all, delete-orphan")
    webhooks = relationship("Webhook", back_populates="bot", cascade="all, delete-orphan")
    meeting_bookings = relationship("MeetingBooking", back_populates="bot", cascade="all, delete-orphan")
    plan = relationship("Plan", foreign_keys=[plan_id])
    subscription = relationship("Subscription", foreign_keys=[subscription_id], post_update=True)


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
    embedding = Column(Vector(768), nullable=True)  # nullable during re-embed; NOT NULL restored after backfill
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
    # Per-session record of inline cards already surfaced to the visitor.
    # Shape: {"leave_message": true, "meeting": true}. Used to suppress
    # duplicate card rendering across turns — the LLM cannot enforce
    # "at most once per conversation" on its own.
    inline_cards_shown = Column(JSONB, nullable=True)
    visitor_rating = Column(Integer, nullable=True)  # Post-chat satisfaction: 1–5, null = not rated
    visitor_resolved = Column(Boolean, nullable=True)  # Post-chat: was the issue resolved? null = not answered

    # Unread-leads tracking: NULL = unread in the /leads admin view.
    # Backed by partial index ix_chat_sessions_bot_id_lead_viewed_at
    # (see migration d4e5f6a7b8c9) to keep sidebar polling cheap.
    lead_viewed_at = Column(DateTime(timezone=True), nullable=True)

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
    # Per-department business hours. Same JSONB shape as ``Bot.business_hours``
    # for code reuse. When a chat session has a ``department_id``, the live
    # chat state resolver checks THIS column first; the bot-level value is the
    # workspace-wide fallback when no department is selected.
    business_hours = Column(JSONB, nullable=True)
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
    # Manual DND toggle — operator can stay "online" (WS connected) but stop
    # accepting new chat assignments. Independent of is_online so capacity
    # planning can distinguish "off shift" from "busy with admin tasks".
    is_accepting_chats = Column(Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Auth credentials (for separate operator login)
    hashed_password = Column(String, nullable=True)
    operator_api_key = Column(String, unique=True, index=True, nullable=True)
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)

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
    # Full chat history captured at form submit so the responding operator has
    # context. Shape: [{"role": "user|bot", "content": "...", "ts": "iso"}, ...]
    transcript = Column(JSONB, nullable=True)
    # Which availability state triggered the fallback to the offline form.
    # One of: no_operators | out_of_hours | all_offline | all_busy | queue_timeout
    # | queue_full | feature_disabled | manual. Drives admin filtering + analytics.
    fallback_reason = Column(String, nullable=True)
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


class LiveChatQueueEntry(Base):
    """Persistent FIFO queue for visitors waiting on a live operator.

    Persisted (not just in-memory) so the queue survives API restarts and
    Redis flushes. Position is computed at insert time from
    ``COUNT(*) WHERE bot_id = X AND dequeued_at IS NULL``; we don't try to
    keep positions densely packed — dequeue_reason marks exits and a daily
    cron prunes resolved entries.
    """

    __tablename__ = "live_chat_queue"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(
        String,
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    bot_id = Column(
        Integer,
        ForeignKey("bots.id", ondelete="CASCADE"),
        nullable=False,
    )
    position = Column(Integer, nullable=False)
    enqueued_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    dequeued_at = Column(DateTime(timezone=True), nullable=True)
    # assigned | timeout | abandoned | bot_returned
    dequeue_reason = Column(String, nullable=True)

    __table_args__ = (
        Index("ix_live_chat_queue_bot_id_dequeued_at", "bot_id", "dequeued_at"),
        Index("ix_live_chat_queue_session_id", "session_id"),
    )


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

    # Pricing (stored in *minor units* of the configured currency — paise for
    # INR, cents for USD — to avoid floating-point issues). The historical
    # column name ``*_cents`` is retained for compatibility; treat it as
    # "minor units of ``currency`` field" in new code.
    pricing_model = Column(
        String, default="per_operator", server_default="per_operator", nullable=False
    )  # per_operator|flat|custom
    currency = Column(String(3), default="INR", server_default="INR", nullable=False)
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

    # ── Credit-based billing fields ──
    # Monthly credit allowance granted on subscription renewal. Use-it-or-lose-it.
    credits_per_month = Column(Integer, default=0, server_default="0", nullable=False)
    # Operator seats included in the base subscription price.
    included_operator_seats = Column(Integer, default=1, server_default="1", nullable=False)
    # Price per additional operator seat above the included number, in cents.
    extra_seat_price_cents = Column(Integer, default=1500, server_default="1500", nullable=False)

    # Stripe integration
    stripe_product_id = Column(String, nullable=True)
    stripe_monthly_price_id = Column(String, nullable=True)
    stripe_annual_price_id = Column(String, nullable=True)

    # Razorpay integration
    razorpay_plan_id_monthly = Column(String, nullable=True)
    razorpay_plan_id_annual = Column(String, nullable=True)

    # Fixed USD headline pricing (cents). Independent of the INR columns —
    # set deliberately, NEVER converted live. Shown to non-Indian visitors and
    # charged by Stripe. NULL → caller falls back to a DISPLAY_USD_TO_INR
    # conversion for legacy rows that predate these columns. See
    # ``app.core.pricing.display_price`` and ADR D2/D3 in the billing plan.
    monthly_price_usd_cents = Column(Integer, nullable=True)
    annual_price_usd_cents = Column(Integer, nullable=True)
    extra_seat_price_usd_cents = Column(Integer, nullable=True)

    # Display & ordering
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    is_default = Column(Boolean, default=False, server_default="false", nullable=False)  # auto-assigned to new clients
    sort_order = Column(Integer, default=0, server_default="0", nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    # ``foreign_keys`` is required because Subscription has TWO FKs into Plan
    # (``plan_id`` for the active plan, ``scheduled_plan_id`` for a queued
    # downgrade). Without the disambiguation, SQLAlchemy can't decide which
    # FK ``Plan.subscriptions`` should follow and refuses to map.
    subscriptions = relationship(
        "Subscription",
        back_populates="plan",
        foreign_keys="Subscription.plan_id",
    )


class Subscription(Base):
    """Links a Client to a Plan — tracks billing state and payment provider details."""

    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id = Column(Integer, ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False)
    # Per-bot billing (f8b2c4d6e1a3): when set, this subscription funds
    # one specific bot rather than the whole client. NULL = legacy
    # client-level subscription (one per client, pre-migration shape).
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)

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
    # Set by the trial-expiry cron when status flips to ``trial_expired``.
    # The hard-delete cron uses this to know when the 15-day grace window
    # ends. ``NULL`` for any subscription that never went through trial
    # expiry (paid customers, free-tier users).
    data_retention_until = Column(DateTime(timezone=True), nullable=True)
    # Set when a payment-failed webhook flips ``status`` to ``past_due``.
    # The auto-expire cron uses this anchor (not ``updated_at``, which
    # mutates on every unrelated row touch) to know when the dunning
    # grace window has elapsed. Reset to ``NULL`` when the customer's
    # card is rescued and status flips back to ``active``.
    past_due_since = Column(DateTime(timezone=True), nullable=True)
    # Idempotency log for trial lifecycle emails. Keys are lifecycle
    # stages (``day_7``, ``day_11``, ``day_13``, ``trial_ended``,
    # ``data_deleted``); values are ISO-8601 timestamps of when each was
    # sent. Missing key == not yet sent. Lets every cron re-run safely.
    trial_emails_sent = Column(JSONB, nullable=False, server_default="{}", default=dict)

    # Cancellation
    canceled_at = Column(DateTime(timezone=True), nullable=True)
    cancel_reason = Column(Text, nullable=True)
    cancel_at_period_end = Column(Boolean, default=False, server_default="false", nullable=False)

    # The Razorpay plan actually billed against — a discounted plan when a
    # referral code applied, else identical to the base plan's razorpay id.
    # Entitlements always follow plan_id (the base plan). NULL for Stripe /
    # legacy rows that predate the discount engine.
    razorpay_billing_plan_id = Column(String, nullable=True)

    # Payment provider IDs
    payment_provider = Column(
        String, default="stripe", server_default="stripe", nullable=False
    )  # stripe|razorpay|manual
    stripe_subscription_id = Column(String, unique=True, index=True, nullable=True)
    stripe_customer_id = Column(String, index=True, nullable=True)
    razorpay_subscription_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_customer_id = Column(String, index=True, nullable=True)
    # Set when a paid→paid transition replaces an existing Razorpay mandate.
    # The activation handler reads this to distinguish a "this is the second
    # subscription in a plan-change" event from a fresh first-time signup.
    prev_razorpay_subscription_id = Column(String, nullable=True)

    # Scheduled plan change — populated when a paid→paid downgrade is queued
    # for cutover at the end of the current billing cycle. The cron + the
    # gateway's ``subscription.completed`` webhook both check these columns;
    # whichever fires first promotes the change and clears the trio.
    scheduled_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    scheduled_billing_cycle = Column(String(16), nullable=True)
    scheduled_change_at = Column(DateTime(timezone=True), nullable=True)
    # Proration value (plan-currency cents) for unused time on the previous
    # plan. Applied as a credit-ledger ``topup`` once the new subscription's
    # ``activated`` webhook confirms payment cleared. Zero means no pending
    # credit — never NULL so arithmetic stays simple.
    upgrade_credit_pending_cents = Column(Integer, default=0, server_default="0", nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    client = relationship("Client", backref="subscriptions")
    plan = relationship("Plan", back_populates="subscriptions", foreign_keys=[plan_id])
    # Read-only relationship for the queued downgrade target. Loading via
    # ``session.get(Plan, sub.scheduled_plan_id)`` works without it, but
    # making the relationship explicit lets call sites that already have a
    # Subscription instance touch ``.scheduled_plan.name`` without a
    # second query.
    scheduled_plan = relationship("Plan", foreign_keys=[scheduled_plan_id])
    invoices = relationship("Invoice", back_populates="subscription", cascade="all, delete-orphan")

    __table_args__ = (
        # Legacy shape: at most one client-level (bot_id NULL) active
        # subscription per client. Preserves the pre-per-bot-billing rule
        # for grandfathered rows.
        Index(
            "ix_subscriptions_client_legacy_active",
            "client_id",
            unique=True,
            postgresql_where=sqlalchemy.text(
                "bot_id IS NULL AND status IN ('active', 'trialing', 'past_due')",
            ),
        ),
        # Per-bot shape: at most one active subscription per (client, bot).
        # Allows a single client to hold many bot-scoped subscriptions
        # concurrently — one per bot they pay for.
        Index(
            "ix_subscriptions_client_bot_active",
            "client_id",
            "bot_id",
            unique=True,
            postgresql_where=sqlalchemy.text(
                "bot_id IS NOT NULL AND status IN ('active', 'trialing', 'past_due')",
            ),
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


# ── Credit-based billing ──────────────────────────────────────────────────────


class CreditLedger(Base):
    """Single source of truth for credit balances.

    Event-sourced: every grant, deduction, refund, and expiry is an immutable
    row with a signed ``delta``. Current balance for a client is
    ``SUM(delta) WHERE client_id = ?``.

    Deduction rows carry a ``grant_id`` pointing back at the grant entry they
    were allocated against (FIFO bookkeeping for top-up expiry). Top-up grants
    set ``expires_at`` 12 months out; plan grants leave it NULL because they
    reset monthly via ``reset_monthly_plan_credits``.
    """

    __tablename__ = "credit_ledger"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    # Per-bot billing (f8b2c4d6e1a3): non-null on entries belonging to a
    # specific bot's ledger. NULL for legacy/client-level entries (every
    # row created before the per-bot rollout, plus any deductions made
    # against legacy-pooled bots after rollout).
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)
    delta = Column(Integer, nullable=False)
    reason = Column(String, nullable=False)  # credit_reason ENUM in PG
    reference_id = Column(Integer, nullable=True)  # chat_message_id, document_id, invoice_id, etc.
    grant_id = Column(Integer, ForeignKey("credit_ledger.id", ondelete="SET NULL"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)  # only set on topup grants
    note = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    client = relationship("Client", foreign_keys=[client_id])
    bot = relationship("Bot", foreign_keys=[bot_id])
    creator = relationship("Client", foreign_keys=[created_by])
    grant = relationship("CreditLedger", remote_side=[id], foreign_keys=[grant_id])

    __table_args__ = (
        Index("ix_credit_ledger_client_created", "client_id", sqlalchemy.text("created_at DESC")),
        Index(
            "ix_credit_ledger_topup_expiry",
            "expires_at",
            postgresql_where=sqlalchemy.text("expires_at IS NOT NULL AND delta > 0"),
        ),
        Index("ix_credit_ledger_grant_id", "grant_id"),
        Index("ix_credit_ledger_reference_id", "reference_id"),
    )


class PricingConfig(Base):
    """Key/value store for super-admin tunable billing parameters.

    Lets the super admin change credit costs and top-up packs without a code
    deploy. Examples:
      * ``credit_cost.ai_chat`` → ``1``
      * ``credit_cost.url_scan`` → ``3``
      * ``seat_price_cents`` → ``1500``
      * ``topup_packs`` → JSON array of {usd, credits, bonus_pct, ...}
      * ``kill_switch`` → ``true`` halts all credit deductions globally
    """

    __tablename__ = "pricing_config"

    key = Column(Text, primary_key=True)
    value = Column(JSONB, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_by = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)


class ProcessedWebhook(Base):
    """Idempotency log for Stripe / Razorpay webhook event IDs.

    Webhook providers retry on 5xx and may deliver duplicates. We store the
    event ID on first successful processing; subsequent deliveries with the
    same ID are short-circuited with a 200 OK.
    """

    __tablename__ = "processed_webhooks"

    event_id = Column(Text, primary_key=True)
    provider = Column(Text, nullable=False, index=True)  # 'stripe' | 'razorpay'
    processed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ── Super-admin audit & supporting tables ────────────────────────────────────


class AuditLog(Base):
    """Immutable audit trail of every super-admin mutation.

    Each row captures who did what to whom, plus a JSON snapshot of the
    before/after state where applicable. Inserted by the ``record_audit``
    helper (services/audit_service.py); never updated or deleted.
    """

    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    actor_id = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    actor_name = Column(String, nullable=True)
    action = Column(String, nullable=False, index=True)
    target_type = Column(String, nullable=True, index=True)
    target_id = Column(String, nullable=True, index=True)
    before = Column(JSONB, nullable=True)
    after = Column(JSONB, nullable=True)
    ip = Column(String, nullable=True)
    user_agent = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    __table_args__ = (Index("ix_audit_logs_actor_created", "actor_id", sqlalchemy.text("created_at DESC")),)


class Coupon(Base):
    """Promotional discount codes that can be applied to plans."""

    __tablename__ = "coupons"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String, nullable=False, unique=True, index=True)
    percent_off = Column(Integer, nullable=True)  # 1..100
    amount_off_cents = Column(Integer, nullable=True)
    max_redemptions = Column(Integer, nullable=True)
    redemptions = Column(Integer, default=0, server_default="0", nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    applies_to_plan_ids = Column(JSONB, nullable=True)  # list[int] | null = all
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class LLMCallLog(Base):
    """Per-call metering for LLM completions and embeddings.

    Written from ``llm_service.py`` after each successful (or failed) call.
    Powers the /superadmin/llm/usage dashboard.
    """

    __tablename__ = "llm_call_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True, index=True)
    model = Column(String, nullable=False, index=True)
    prompt_tokens = Column(Integer, default=0, server_default="0", nullable=False)
    completion_tokens = Column(Integer, default=0, server_default="0", nullable=False)
    cost_cents = Column(Integer, default=0, server_default="0", nullable=False)
    latency_ms = Column(Integer, default=0, server_default="0", nullable=False)
    fallback_used = Column(Boolean, default=False, server_default="false", nullable=False)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class ImpersonationToken(Base):
    """Short-lived (30 min) token allowing a super-admin to act as a customer.

    Persisted so it can be revoked, audited, and inspected. The actual token
    string is stored hashed; only the prefix is human-readable.
    """

    __tablename__ = "impersonation_tokens"

    id = Column(Integer, primary_key=True, autoincrement=True)
    token_hash = Column(String, nullable=False, unique=True, index=True)
    actor_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    target_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ─── Affiliate Program v1 (money-free) ──────────────────────────────────
#
# v1 ships the referral-code mechanic, attribution, and analytics dashboards
# only. The money layer (commission %, customer discount %, payouts) is
# deferred to v2 — see ``platform/docs/affiliate-program.md`` for details
# and the additive migration path. None of the columns here carry money;
# v2 will ADD columns to these same tables without rewriting existing data.


class Affiliate(Base):
    """Invite-only affiliate membership tied to a Client (0..1 per client).

    The presence of an active (``deactivated_at IS NULL``) row is the
    single source of truth for ``Client.is_affiliate``. Total active
    affiliates are capped at 5 by the service layer — there is no DB-level
    enforcement of this because raising the cap should not require a
    migration.
    """

    __tablename__ = "affiliates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    invited_by = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )
    max_active_codes = Column(Integer, nullable=False, default=10, server_default="10")
    # Commission % stored in basis points (1 bps = 0.01%). 2500 = 25.00%.
    # Default 0 = no commission; super-admin sets explicitly when ready to
    # pay out. Range enforced at the DB layer (0–10000 = 0–100%).
    commission_bps = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    deactivated_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "max_active_codes > 0",
            name="chk_affiliate_max_codes_positive",
        ),
        CheckConstraint(
            "commission_bps >= 0 AND commission_bps <= 10000",
            name="chk_affiliate_commission_bps_range",
        ),
    )

    client = relationship("Client", foreign_keys=[client_id], back_populates="affiliate")
    invited_by_client = relationship("Client", foreign_keys=[invited_by])
    codes = relationship(
        "ReferralCode",
        back_populates="affiliate",
        cascade="all, delete-orphan",
    )


class ReferralCode(Base):
    """Per-affiliate referral code with optional internal label.

    Code names are globally unique and case-insensitive (``CITEXT``). The
    DB-level CHECK constraint enforces the 3-20 char ``[A-Za-z0-9_-]``
    format, mirroring the regex enforced at the service layer. Deactivated
    codes (``active = false``) keep their referrals intact but block new
    signups.
    """

    __tablename__ = "referral_codes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    affiliate_id = Column(
        Integer,
        ForeignKey("affiliates.id", ondelete="RESTRICT"),
        nullable=False,
    )
    code = Column(CITEXT, nullable=False, unique=True)
    label = Column(Text, nullable=True)
    active = Column(Boolean, nullable=False, default=True, server_default="true")
    # Per-code commission split (basis points). The pair must sum to ≤ the
    # affiliate's overall commission_bps (the pool set by the super-admin).
    # The service layer enforces that cross-table constraint; the DB CHECK
    # below only enforces the individual ranges + the absolute 100% ceiling.
    affiliate_commission_bps = Column(Integer, nullable=False, default=0, server_default="0")
    customer_discount_bps = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    deactivated_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            r"code ~ '^[A-Za-z0-9_-]{3,20}$'",
            name="chk_referral_code_format",
        ),
        CheckConstraint(
            "affiliate_commission_bps >= 0 AND affiliate_commission_bps <= 10000 "
            "AND customer_discount_bps >= 0 AND customer_discount_bps <= 10000 "
            "AND (affiliate_commission_bps + customer_discount_bps) <= 10000",
            name="chk_code_split_range",
        ),
    )

    affiliate = relationship("Affiliate", back_populates="codes")
    clicks = relationship(
        "ReferralClick",
        back_populates="code",
        cascade="all, delete-orphan",
    )


class ReferralClick(Base):
    """Append-only click log for ``/?ref=CODE`` visits.

    Stores hashed IP and UA only — never raw values. The hash salt rotates
    daily inside the service layer so cross-day correlation requires
    out-of-band knowledge.
    """

    __tablename__ = "referral_clicks"

    id = Column(sqlalchemy.BigInteger, primary_key=True, autoincrement=True)
    code_id = Column(
        Integer,
        ForeignKey("referral_codes.id", ondelete="CASCADE"),
        nullable=False,
    )
    ip_hash = Column(Text, nullable=True)
    ua_hash = Column(Text, nullable=True)
    referrer = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    code = relationship("ReferralCode", back_populates="clicks")


class AffiliateInvite(Base):
    """Pending magic-link invite for someone who is not yet a Client.

    Super admin invites by email; if the email doesn't match any existing
    Client, an invite row is created with a one-time token. The recipient
    receives a link to ``/affiliate-invite?token=<raw>`` which atomically
    creates their ``clients`` row and ``affiliates`` row in a single
    transaction. The raw token is emailed once and never persisted; only
    its sha256 hash is stored here. Same pattern as ``ImpersonationToken``.

    Lifecycle:
      created → (sent via email) → accepted XOR revoked XOR expired
    """

    __tablename__ = "affiliate_invites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String, nullable=False)
    token_hash = Column(Text, nullable=False, unique=True, index=True)
    max_active_codes = Column(Integer, nullable=False, default=10, server_default="10")
    invited_by = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "max_active_codes > 0",
            name="chk_invite_max_codes_positive",
        ),
    )

    invited_by_client = relationship("Client", foreign_keys=[invited_by])


# ── Discount engine ────────────────────────────────────────────────────────────


class DiscountedPlanCache(Base):
    """Reuse cache for API-created discounted Razorpay plans.

    The UNIQUE (base_plan_id, billing_cycle, discount_bps) constraint is the
    deduplication key: the same discount on the same base+cycle always resolves
    to one Razorpay plan, shared across all affiliates and customers. This caps
    the total number of Razorpay plans at base × cycle × distinct_discount_pcts
    (~100 plans maximum even at millions of customers).
    """

    __tablename__ = "discounted_plan_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    base_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), nullable=False)
    billing_cycle = Column(String, nullable=False)  # "monthly" | "annual"
    discount_bps = Column(Integer, nullable=False)  # e.g. 1500 = 15 %
    razorpay_plan_id = Column(String, nullable=False)
    amount_paise = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "base_plan_id",
            "billing_cycle",
            "discount_bps",
            name="uq_discounted_plan",
        ),
        CheckConstraint(
            "discount_bps > 0 AND discount_bps < 10000",
            name="chk_discount_bps_range",
        ),
    )


class ReferralConversion(Base):
    """Snapshot of commission/discount terms when a referral converts to paid.

    Editing a referral code's percentages later must not retroactively change
    what already-converted customers earn the affiliate — snapshotting at
    subscribe time decouples live code edits from historical payouts.
    """

    __tablename__ = "referral_conversions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    referral_code_id = Column(Integer, ForeignKey("referral_codes.id", ondelete="SET NULL"), nullable=True)
    affiliate_id = Column(Integer, ForeignKey("affiliates.id", ondelete="SET NULL"), nullable=True)
    commission_bps = Column(Integer, nullable=False)
    customer_discount_bps = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PlatformFeedback(Base):
    """
    Free-text feedback submitted by admin dashboard users about the OyeChats
    platform itself (the floating "Feedback" side tab in the admin panel).
    Distinct from ChatMessage.feedback (visitor thumbs-up/down on bot replies).
    """

    __tablename__ = "platform_feedback"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    message = Column(Text, nullable=False)
    attachment_url = Column(String, nullable=True)
    category = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)

    client = relationship("Client", foreign_keys=[client_id])
