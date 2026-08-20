import sqlalchemy
import sqlalchemy.event  # explicit: `@sqlalchemy.event.listens_for` below (not auto-loaded by `import sqlalchemy`)
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, TSVECTOR
from sqlalchemy.dialects.postgresql import ENUM as PG_ENUM
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    company_name = Column(String, nullable=True)
    # ── Buyer tax identity (invoicing v2). All nullable; captured in account
    # settings / at checkout. billing_state_code is the GST place-of-supply
    # input (Circular 242/36/2024 makes state mandatory for online B2C.
    # Enforced at checkout, not at the column level, to keep signup friction
    # unchanged).
    legal_name = Column(String, nullable=True)
    gstin = Column(String(15), nullable=True)
    billing_address = Column(JSONB, nullable=True)  # {line1, line2, city, postal_code}
    billing_country = Column(String(2), nullable=True)  # ISO-2, e.g. "IN"
    billing_state_code = Column(String(2), nullable=True)  # GST state code, e.g. "27"
    billing_email = Column(String, nullable=True)  # falls back to login email
    # Push/alert opt-outs for the workspace owner. Same JSONB shape as
    # ``Operator.notification_preferences`` so one evaluator serves both, the
    # owner is a chat recipient too (``send_push_to_client``) and previously had
    # no way to mute anything.
    notification_preferences = Column(JSONB, nullable=True)
    # Newest billing-geo contradiction (claimed country vs server-side IP geo),
    # both directions. Durable GST/FEMA review trail, not just a WARN log.
    geo_mismatch_at = Column(DateTime(timezone=True), nullable=True)
    geo_mismatch_detail = Column(String(500), nullable=True)
    # In-flight FIRST checkout (H1 pattern): a sequential re-submit reuses this
    # gateway subscription instead of minting a second authorizable mandate.
    # Gateway state (rebuild_upgrade_checkout) decides staleness, not a TTL;
    # cleared by the activation webhook. Upgrade/resume park theirs on the
    # Subscription row; a first checkout has no row yet, hence here.
    #
    # Shared by BOTH first-mandate routes. ``POST /subscriptions/checkout`` and
    # ``/subscriptions/change-plan`` Branch 3 (trial→paid, Free→paid, revive).
    # Branch 3 had no marker at all until 2026-08-14, so a retry there minted a
    # SECOND authorizable mandate and the customer was charged twice for one
    # month (prod client 18). See ``pending_checkout_service``.
    pending_checkout_subscription_id = Column(String, nullable=True)
    pending_checkout_plan_id = Column(Integer, nullable=True)
    pending_checkout_cycle = Column(String(8), nullable=True)
    # The confirmed country the pending sub was minted under. Part of the
    # reuse key so a country change never reuses a wrong-rail checkout.
    pending_checkout_country = Column(String(2), nullable=True)
    # The bot the pending mandate funds (change-plan's revive-in-place path), or
    # NULL for an account-level checkout. Part of the reuse key for the same
    # reason the country is: an account-scoped in-flight mandate must never be
    # handed back for a per-agent purchase, or the activation would attach the
    # plan to the wrong ledger.
    pending_checkout_bot_id = Column(Integer, nullable=True)
    pending_checkout_at = Column(DateTime(timezone=True), nullable=True)
    # Razorpay Customer id, the identity anchor for saved payment instruments.
    # Tokens hang off a customer (GET /v1/customers/{id}/tokens), so without
    # this there is no saved-card capability at all.
    #
    # Distinct from ``Subscription.razorpay_customer_id``, which is a PASSIVE
    # mirror scraped out of webhook payloads and is routinely NULL even on a
    # live mandate. This column is the one we create and own; the subscription
    # copy stays for webhook correlation.
    razorpay_customer_id = Column(String, unique=True, index=True, nullable=True)
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
    # paid seats, same pattern as max_bots.
    extra_bot_seats = Column(Integer, default=0, server_default="0", nullable=False)
    # Running total of *cleaned pre-chunk* characters ingested into this
    # account's knowledge base across every bot. Incremented at ingest time
    # and decremented on delete; ``knowledge_quota_service.recompute_kb_usage``
    # can rebuild it from the ``documents.source_char_count`` column when
    # drift is suspected. Enforced against ``plan.limits.knowledge_characters``
    # in the ingestion pipeline. BigInteger because unlimited-tier accounts
    # can genuinely accumulate more than ``INT4`` (2.1B chars ≈ 420M words).
    kb_characters_used = Column(BigInteger, default=0, server_default="0", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Email OTP verification
    is_verified = Column(Boolean, default=False, nullable=False, server_default="false")
    email_otp = Column(String, nullable=True)
    email_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

    # First-run onboarding wizard completion. Starts False for every new
    # account (both email/password and OAuth signups) and flips True once the
    # user finishes the dashboard's guided setup. The admin app reads this off
    # /auth/me to decide whether to route into the onboarding flow.
    onboarding_complete = Column(Boolean, default=False, server_default="false", nullable=False)

    # Password reset fields
    reset_otp = Column(String, nullable=True)
    reset_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

    # Email change verification. The login email only ever moves to
    # ``pending_email`` once the OTP sent to that *new* address is confirmed
    # (see /client/change-email/*), a bare profile PATCH can no longer
    # overwrite ``email`` directly, so a hijacked session can't silently
    # redirect account recovery to an attacker-controlled inbox.
    pending_email = Column(String, nullable=True)
    email_change_otp = Column(String, nullable=True)
    email_change_otp_expires_at = Column(DateTime(timezone=True), nullable=True)

    # ── Affiliate program v1 (referral attribution) ──
    # First-touch attribution: set once at signup if a valid ?ref=code cookie
    # is present, then immutable. ``referral_code_id`` is FK to referral_codes.
    referral_code_id = Column(
        Integer,
        ForeignKey("referral_codes.id", ondelete="SET NULL"),
        nullable=True,
    )
    referral_attributed_at = Column(DateTime(timezone=True), nullable=True)

    # Launch-promo attribution. Set once at signup from the campaign link's
    # ``?code=`` when it matches a known promotion. Makes the offer
    # link-exclusive: only accounts that arrived through the campaign link
    # qualify (promotion_service matches this against the promo's ``code``).
    # NULL = signed up without a promo code (organic → normal pricing).
    signup_promo_code = Column(String, nullable=True)

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
    # Legacy relationships. Kept until migration removes client_id from these tables
    documents = relationship(
        "Document", back_populates="client", cascade="all, delete-orphan", foreign_keys="Document.client_id"
    )
    chat_sessions = relationship(
        "ChatSession", back_populates="client", cascade="all, delete-orphan", foreign_keys="ChatSession.client_id"
    )
    # Affiliate membership (0..1). Derived ``is_affiliate`` reads this, the
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
    # removes the OAuth links. Provider rows on Google's side are not
    # affected because we only store the provider's stable subject id.
    oauth_accounts = relationship(
        "OAuthAccount",
        back_populates="client",
        cascade="all, delete-orphan",
    )

    @property
    def is_affiliate(self) -> bool:
        """True iff this client has an active (non-deactivated) affiliate row.

        Derived from the ``affiliate`` relationship. There is no separate
        boolean column, so the relationship is the single source of truth.
        Callers that touch this property must have the ``affiliate`` row
        loaded (eager or via the same session); otherwise it returns False.
        """
        aff = self.affiliate
        return aff is not None and aff.deactivated_at is None


class OAuthAccount(Base):
    """External identity provider link for a Client.

    One row per (provider, provider_user_id) pair. ``provider_user_id`` is
    the provider's stable subject identifier (Google's ``sub`` claim), never
    the user's email, which can change. Matching by ``provider_user_id`` is
    what lets a returning OAuth user log in even if they later changed their
    Google account's primary email.

    A single Client can have multiple OAuthAccount rows (future: Google +
    GitHub on the same workspace) but only one per provider. Enforced by
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
        # Same provider account can't be linked to two Clients. Enforces
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
    # Which brand-tone preset chip is active: a key from brand_tone.PRESET_KEYS,
    # "custom" (text hand-edited away from any preset), or NULL (empty/never set).
    # Descriptive metadata for the UI only, never fed to the prompt; rides along
    # with brand_tone on crawl/detect writes. See app/services/brand_tone.py.
    brand_tone_preset = Column(String, nullable=True)
    company_name = Column(String, nullable=True)  # Auto-extracted or manually set company/brand name
    company_description = Column(Text, nullable=True)  # Auto-extracted or manually set company description
    # Cached onboarding "seed questions". LLM-proposed + retrieval-verified as
    # answerable from this bot's content (see seed_questions_service). Computed
    # once during the Build Studio Prove step; null = not computed yet, [] =
    # computed but nothing passed verification (show only the open input).
    seed_questions = Column(JSONB, nullable=True)

    # Kill switch for the manual lead follow-up email (``POST
    # /leads/{id}/followup``, Gate 4). While true the route refuses with 423
    # and no override exists. Historically platform-side only, with no writer
    # outside a super-admin/DB edit; it is now customer-writable through
    # ``PATCH /bots/{id}`` so the account that owns the mailbox owns the pause.
    followup_sending_paused = Column(Boolean, default=False, server_default="false")
    # Durable per-bot ingestion ("trained") state. Lets the frontend read a
    # persistent fact instead of racing the ephemeral, client-scoped
    # /crawl/progress toast (which CrawlContext clears a few seconds after
    # completion).
    #
    # ``last_crawl_status`` ∈ {'done','failed','cancelled'}. Crawl-specific, so
    # only the crawl orchestrator writes it. It describes the last crawl ATTEMPT
    # and must never be read as "does this bot have knowledge": a bot can hold
    # plenty of content from uploads while its last crawl failed.
    #
    # ``indexed_chunk_count`` is the bot's CURRENT total stored chunk count and
    # ``crawl_completed_at`` the moment its knowledge last changed. Both are
    # recomputed from the documents table by ``sync_bot_knowledge_state`` after
    # every knowledge mutation (crawl, upload, delete), never incremented from
    # a single job's delta. That matters: a delta recrawl of an unchanged site
    # ingests zero new chunks, and a document upload runs no crawl at all, so
    # anything derived from one job's output would leave a well-trained bot
    # reading "never trained".
    last_crawl_status = Column(String, nullable=True)
    crawl_completed_at = Column(DateTime(timezone=True), nullable=True)
    indexed_chunk_count = Column(Integer, default=0, server_default="0", nullable=False)
    # Names of auto-fillable fields the customer has edited by hand
    # (subset of {"company_name", "company_description", "brand_tone"}). A field
    # listed here is "locked" and the website crawl leaves it untouched; fields
    # not listed are refreshed from the crawl. Clearing a field and saving
    # removes it from this list, re-enabling auto-fill on the next crawl.
    # Reconciled in ``bot_routes.update_bot`` and honored in ``crawl_orchestrator``.
    manual_field_overrides = Column(JSONB, nullable=False, default=list, server_default=sqlalchemy.text("'[]'::jsonb"))
    website = Column(String, nullable=True)
    bot_logo = Column(Text, nullable=True)
    # Who last wrote the avatar. NULL = nobody has ever set it; "manual" = the
    # customer did (uploading one OR removing one); "derived" = the crawl took
    # it from the site's favicon.
    #
    # Provenance, deliberately NOT folded into `avatar_type`. That is a style
    # selector with exactly three legal values that the admin UI renders as a
    # segmented control, and a fourth value would break it.
    #
    # This is what makes "no avatar" answerable. `bot_logo IS NULL` alone
    # cannot distinguish an agent nobody has touched from one whose owner
    # deliberately removed the picture, so the crawl re-derived the avatar the
    # customer had just deleted. Derivation runs only while this is NULL.
    bot_logo_source = Column(String, nullable=True)
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
    # Reasonable range: 0.40 (lenient). 0.70 (strict). Out-of-range is clamped at runtime.
    relevance_threshold = Column(Float, nullable=True)
    avatar_type = Column(String, default="upload", server_default="upload", nullable=False)
    orb_color = Column(String, nullable=True)

    # Lead capture form settings
    lead_form_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    lead_form_fields = Column(JSONB, nullable=True)  # e.g. [{"field":"name","required":true}]

    # ── Metered lead-enrichment opt-ins (AI Agent > Advanced) ───────────────
    #
    # Both default OFF. Enrichment spends credits, so it is an explicit opt-in
    # the customer turns on when they want it, not a paid feature left running
    # until they happen to find a settings page. Each is one of THREE
    # independent gates, all of which must pass before a credit is spent:
    #   1. the plan  (Standard/Professional, enforced server-side)
    #   2. the super-admin kill switch (``feature.<name>_enabled``)
    #   3. this per-agent customer toggle
    #
    # Verification runs via Reoon at ``credit_cost.email_verification`` per
    # captured lead.
    email_verification_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    # The IP-to-company lookup, at ``credit_cost.company_name``, charged only
    # when a company is actually identified (see chat_routes).
    company_lookup_enabled = Column(Boolean, default=False, server_default="false", nullable=False)

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
    # Per-bot grace periods, in seconds, for the two live-chat disconnect
    # timers. Only ONE of them is a customer-facing setting.
    #
    # ``visitor_disconnect_timeout`` IS read at runtime:
    # ``live_chat_service.handle_visitor_disconnect`` prefers it over
    # ``DEFAULT_VISITOR_DISCONNECT_TIMEOUT`` (120s, the same number as this
    # column's default) before auto-closing an abandoned chat. It is therefore
    # customer-writable through ``PATCH /bots/{id}``, bounded 5..3600 at the
    # API boundary to match ``operator_timeout_seconds``.
    #
    # ``operator_disconnect_timeout`` is NOT read by anything:
    # ``live_chat_service._operator_disconnect_timeout`` sleeps the class
    # constant ``DEFAULT_OPERATOR_DISCONNECT_TIMEOUT`` (60s, again this
    # column's default) and never looks the column up. It is consequently NOT
    # exposed on ``UpdateBotRequest``/``BotResponse``: a setting that validates,
    # persists and echoes back while changing nothing teaches customers that
    # the settings page is decorative. Wiring belongs in ``live_chat_service``
    # (``_operator_disconnect_timeout`` already receives ``operator_id``; one
    # ``Operator`` -> ``Bot`` lookup yields the value, mirroring how
    # ``handle_visitor_disconnect`` reads its peer), and the API fields go back
    # in the same change.
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
    meeting_provider = Column(String, nullable=True)  # "calendly" | "zcal" | "calcom" | null
    zcal_url = Column(String, nullable=True)
    calcom_url = Column(String, nullable=True)

    # Feature flags. Controls per-bot widget/operator behavior toggles
    feature_flags = Column(
        JSONB,
        nullable=False,
        server_default='{"file_sharing": false, "post_chat_rating": true, "show_branding": true, "queue_position": false, "typing_preview": true, "email_transcript": false}',
    )

    # Widget messages. All customizable user-facing strings (welcome, chat input, error messages, etc.)
    widget_messages = Column(
        JSONB,
        nullable=False,
        server_default='{"welcome_greeting": "Hi There, How can I help you today?", "welcome_suggestions": ["Our Services", "About us", "Contact us"], "input_placeholder": "Write a message...", "live_chat_label": "Live chat", "greeting_message": "Hi! Let us know if you have any questions.", "offline_message": "We\'ll be right back! Leave a message and we\'ll follow up shortly.", "rating_prompt": "How was your experience?", "end_chat_label": "End chat and return to AI"}',
    )

    # Widget configuration. Timing, thresholds, and advanced settings
    widget_config = Column(
        JSONB,
        nullable=False,
        server_default='{"welcome_exit_duration_ms": 350, "greeting_delay_ms": 3000, "typing_timeout_ms": 2000, "frustration_window_ms": 30000, "frustration_threshold_messages": 3, "max_reconnect_attempts": 15, "max_reconnect_delay_ms": 30000, "heartbeat_visible_ms": 25000, "heartbeat_hidden_ms": 50000, "handoff_auto_submit_delay_ms": 300}',
    )

    # Widget branding. Customizable branding text and URL
    branding_text = Column(String, default="Powered by OyeChats", server_default="Powered by OyeChats", nullable=False)
    branding_url = Column(
        String, default="https://www.oyechats.com", server_default="https://www.oyechats.com", nullable=False
    )

    # Service-scoped answers. When ``services`` is non-empty the bot is constrained
    # to only answer about those services. ``services_url`` is appended as a CTA
    # under each on-scope answer (e.g. "Learn more: [Our Services](url)") and
    # auto-suggested from the URL crawl when not set explicitly by the admin.
    services = Column(JSONB, nullable=True)  # list[str] of admin-defined service names
    services_url = Column(String, nullable=True)

    # Smart links. Admin-defined keyword→URL map, independent of ``services``.
    # When the bot's answer naturally references one of these keywords it links
    # the phrase to the mapped page (e.g. "pricing" → the pricing page). Stored
    # as ``list[{"keyword": str, "url": str}]``. Nullable and additive: a bot
    # that never sets it behaves exactly as before. Distinct from the services
    # answer-scope above. Smart links never restrict what the bot may answer.
    answer_links = Column(JSONB, nullable=True)

    # Widget embed origin restriction. When ``domain_check_enabled`` is true the
    # backend rejects ``X-Bot-Key`` requests whose Origin/Referer hostname does not
    # match an entry in ``allowed_domains``. Entries support exact hostnames
    # (``acme.com``) and wildcard subdomains (``*.acme.com``). The flag defaults
    # ON (secure-by-default) while ``allowed_domains`` defaults empty; enforcement
    # fails open on an empty allowlist (see ``_enforce_bot_origin``), so a new bot
    # is only actually locked down once its owner configures domains.
    allowed_domains = Column(
        JSONB,
        nullable=False,
        default=list,
        server_default=sqlalchemy.text("'[]'::jsonb"),
    )
    domain_check_enabled = Column(Boolean, default=True, server_default="true", nullable=False)

    # Cross-subdomain session continuity. When set to a registrable domain
    # (e.g. ``example.com``), the widget mirrors the visitor's session id into a
    # cookie scoped to that parent domain so a conversation started on
    # ``example.com`` continues on ``academy.example.com``. ``localStorage``
    # alone can't cross that origin boundary. NULL/empty = disabled (default),
    # meaning each origin keeps its own independent session as before. Stored as
    # a bare hostname; the widget prepends the leading dot at cookie-write time.
    session_share_domain = Column(String, nullable=True)

    # First time the embedded widget was seen bootstrapping from a real external
    # site (not the dashboard preview / demo / localhost). Stamped exactly once
    # by the public settings endpoint; lets the dashboard confirm the widget is
    # actually live without a user self-report. NULL = never seen installed.
    widget_installed_at = Column(DateTime(timezone=True), nullable=True)

    # Liveness heartbeat for the same install, refreshed by the public settings
    # endpoint. ``widget_installed_at`` answers "did they ever finish the
    # install"; these two answer "is it still running, and where", which is the
    # question every allow-list support ticket actually asks.
    #
    # NULL is a real state on both: "not seen since this shipped". There is no
    # backfill, so an install stamped before these columns existed reads NULL
    # until its widget next bootstraps.
    #
    # Write rate is throttled in ``bot_routes._widget_heartbeat_due`` by two
    # Redis ``SET NX EX`` gates on PER-BOT keys: at most 2 UPDATEs per bot per
    # hour (an hourly refresh plus one allowance for a changed origin), and
    # none at all when Redis is unreachable. That matters because the endpoint
    # runs on every widget bootstrap, i.e. every page view on every customer
    # site. The throttle is NOT keyed on the origin, because the origin is an
    # attacker-supplied header on an endpoint whose bot key is public, and a
    # per-origin key would let a loop of forged ``Origin`` values buy one row
    # write and one hour-long Redis key per request.
    widget_last_seen_at = Column(DateTime(timezone=True), nullable=True)
    # The Origin/Referer hostname of the most recent bootstrap.
    #
    # SECURITY: browser-forgeable. ``Origin`` is only trustworthy coming from a
    # real browser; any HTTP client can send whatever it likes, and the bot key
    # that authenticates the write is public by design (it ships in the embed
    # snippet), so anyone holding it can put an arbitrary string here. Support
    # must read this as a HINT about which domain an agent appears to run on,
    # never as proof that it does. This column is therefore DIAGNOSTIC ONLY and
    # must never gate anything, in particular it must never be consulted for
    # embed-origin enforcement, which belongs to ``allowed_domains`` /
    # ``domain_check_enabled`` and its own check in
    # ``auth._enforce_bot_origin``.
    #
    # Length is bounded upstream, not here: ``origin_check.extract_hostname``
    # returns None for anything over 253 characters (the DNS presentation-form
    # cap), so no oversized value reaches this column. That bound is load-
    # bearing rather than tidy -- this value rides into the bot-config Redis
    # entry that every widget bootstrap reads, and ``urlparse`` will happily
    # call five kilobytes of junk a hostname.
    widget_last_origin = Column(String, nullable=True)

    # Is this chatbot serving, and is it billable? Both, and the billing half is
    # the one that surprises people: ``plan_entitlements_service`` counts only
    # ``is_active`` bots in both ``can_client_add_new_bot`` and
    # ``usage["bots"]``, so deactivating FREES A BILLING SLOT. That is why the
    # false→true transition in ``bot_routes.update_bot`` re-runs the full create
    # gate rather than writing the column straight through.
    #
    # On the read side the split is asymmetric, and intentionally so. The
    # VISITOR-facing paths filter it: ``auth.get_current_bot`` refuses an
    # inactive bot (this is what makes a pause actually pause), the
    # ``X-API-Key`` default-bot fallback next to it 404s "No active bot found",
    # and ``bot_routes.get_bot_demo_page`` 404s the public demo page. The
    # OWNER-facing surfaces do NOT filter: ``GET /bots`` keeps a paused bot
    # visible to the account that owns it so it can be resumed, and
    # ``subscription_routes.get_credit_balance`` deliberately does not filter
    # either -- a paused agent with its own subscription is still billed and
    # still holds an expiring balance, so hiding its card hid live money. See
    # the argument at that function.
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

    # ── Auto-recrawl (weekly refresh of previously-crawled URLs) ──────────
    # Gated by the ``auto_recrawl`` feature flag on the client's plan
    # (Standard + Professional). ``next_recrawl_at`` is stamped as
    # ``now + 7 days`` on toggle-on and cleared on toggle-off. See
    # ``recrawl_service`` and ``task_auto_recrawl_sweep``. The partial
    # index ``ix_bots_next_recrawl_due`` keeps the sweep query cheap.
    recrawl_enabled = Column(Boolean, default=False, server_default="false", nullable=False)
    next_recrawl_at = Column(DateTime(timezone=True), nullable=True)
    last_recrawl_at = Column(DateTime(timezone=True), nullable=True)
    last_recrawl_status = Column(String, nullable=True)  # success | partial | failed | empty
    last_recrawl_summary = Column(JSONB, nullable=True)
    # Rolling window (most-recent 20) of past recrawl runs. Powers the
    # Sources-table history expander. Each element: ``{"ran_at": str,
    # "status": str, "total": int, "unchanged": int, "changed": int,
    # "failed": int}``. Older entries are trimmed inside
    # ``recrawl_service._persist_summary`` so the JSONB never grows without
    # bound.
    recrawl_history = Column(
        JSONB,
        nullable=False,
        default=list,
        server_default=sqlalchemy.text("'[]'::jsonb"),
    )

    # Relationships
    client = relationship("Client", back_populates="bots")
    documents = relationship("Document", back_populates="bot", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="bot", cascade="all, delete-orphan")
    lead_infos = relationship("LeadInfo", back_populates="bot", cascade="all, delete-orphan")
    growth_events = relationship("BotGrowthEvent", back_populates="bot", cascade="all, delete-orphan")
    webhooks = relationship("Webhook", back_populates="bot", cascade="all, delete-orphan")
    meeting_bookings = relationship("MeetingBooking", back_populates="bot", cascade="all, delete-orphan")
    events = relationship("Event", back_populates="bot", cascade="all, delete-orphan")
    plan = relationship("Plan", foreign_keys=[plan_id])
    subscription = relationship("Subscription", foreign_keys=[subscription_id], post_update=True)


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Legacy FK. Kept during migration transition. Indexed (ix_documents_client_id)
    # for the tenant filter in the vector-search query (repository.py).
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True, index=True)
    # New FK. Primary association. Indexed (ix_documents_bot_id) for the tenant
    # filter in the vector-search query (repository.py).
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=True, index=True)

    document_name = Column(String, nullable=False)
    # Explicit ingestion source (remediation M7): "upload" for a file the
    # customer uploaded, "crawl" for a page ingested from a URL. Replaces the
    # fragile ``document_name LIKE 'http%'`` heuristic for the documents quota,
    # a file literally named ``https-notes.pdf`` is no longer mis-classified.
    source = Column(String, nullable=False, default="upload", server_default="upload")
    # Whether this chunk is currently part of the bot's live knowledge. Every
    # retrieval / listing query is scoped to ``is_active = true`` (repository.py).
    # Set to false in bulk (per bot) when a paid subscription lapses to Free
    # (``knowledge_state_service.deactivate_bot_knowledge``): the bot keeps its
    # data but stops answering from it until the customer re-adds knowledge on
    # Free or re-upgrades, which flips it back to true. Indexed because it joins
    # the tenant filter on the hottest query path (vector search).
    is_active = Column(Boolean, nullable=False, default=True, server_default="true", index=True)
    file_hash = Column(String, index=True, nullable=False)
    content = Column(Text, nullable=False)
    # ``len(cleaned_source_text)``, the character count of the SOURCE document
    # (post-clean, pre-chunk), replicated on every chunk of that source. Used to
    # (a) decrement ``clients.kb_characters_used`` on delete without re-computing
    # from scratch, and (b) rebuild the client counter from source-of-truth when
    # drift is suspected. Replicated (not stored once per source) because we
    # don't model a source-level parent row today; ``SELECT DISTINCT ON
    # (document_name, bot_id) source_char_count`` avoids double-counting. Nullable
    # so pre-migration rows don't fail their NOT NULL check. Treated as 0 by
    # ``recompute_kb_usage``.
    source_char_count = Column(Integer, nullable=True)
    metadata_info = Column(JSONB, nullable=True)
    embedding = Column(Vector(768), nullable=False)  # NOT NULL restored after 768-dim re-embed backfill (NB-2)
    search_vector = Column(TSVECTOR)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client", back_populates="documents", foreign_keys=[client_id])
    bot = relationship("Bot", back_populates="documents")

    __table_args__ = (
        Index("ix_documents_search_vector", "search_vector", postgresql_using="gin"),
        # Composite btree matching the filter EVERY vector search applies
        # (repository.py ``search_similar_documents``: bot_id + client_id +
        # is_active, then ORDER BY ``embedding <=>``). Retrieval runs as an exact
        # bitmap scan over one tenant's rows. 100% recall, and faster than ANN
        # at these tenant sizes.
        #
        # There is deliberately NO global HNSW index (dropped in migration
        # c2e8b41f07d9). A global approximate index filters AFTER the graph walk,
        # so a small tenant inside a large shared graph got ZERO rows back with
        # no error. Measured: a 300-chunk tenant in a 45k-row corpus returned
        # nothing, at every ``hnsw.ef_search`` value up to the maximum.
        #
        # Reintroduce ANN only per-tenant (partition by bot_id, one HNSW index
        # per partition, pgvector >= 0.8.0 with hnsw.iterative_scan) once a
        # single bot's exact scan actually becomes the bottleneck (~5k chunks).
        # bot_id/client_id b-tree indexes are declared via ``index=True`` above.
        Index("ix_documents_bot_id_is_active", "bot_id", "is_active"),
    )


class LeadInfo(Base):
    """Captured lead contact information from pre-chat forms or handoff forms."""

    __tablename__ = "lead_info"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), unique=True, nullable=False)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    # The registrable domain of the captured email, e.g. "infosys.com". Kept as
    # the raw domain, NOT overwritten with a resolved name: it is free, always
    # available, and the only thing this column has ever meant. Consumers
    # (CSV export, webhooks, the leads list) already read it.
    company = Column(String, nullable=True)

    # ── Resolved company identity (company_profile_service) ─────────────────
    #
    # Populated from the cross-tenant `company_profile` cache, which turns a
    # domain into the company's own declared identity. "infosys.com" becomes
    # "Infosys Limited". Separate columns rather than overwriting `company`
    # so a failed or pending resolution always degrades to the domain rather
    # than to nothing, and so an operator can see both.
    company_name = Column(String, nullable=True)
    company_description = Column(Text, nullable=True)
    company_logo_url = Column(String, nullable=True)

    metadata_json = Column(JSONB, nullable=True)
    suppression_reason = Column(String, nullable=True)
    is_b2b = Column(Boolean, nullable=True)
    is_valid_email = Column(Boolean, nullable=True)
    email_score = Column(Integer, nullable=True)

    # Manual follow-up tracking (Gate 2 cooldown + audit trail). There is no
    # automatic/timed send anywhere in this system, an operator triggers
    # this from the Admin Panel; these two columns are what that endpoint
    # checks/records. See docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02.
    last_followup_sent_at = Column(DateTime(timezone=True), nullable=True)
    followup_sent_by_operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)

    # Durable source attribution. Snapshot of the parent session's UTM +
    # visitor journey at the moment this lead was captured. Kept on the
    # lead row (not just the session) so attribution survives session
    # pruning by retention policies. Populated only when the owning
    # client is on a plan that includes the Lead Source Attribution
    # feature (Standard / Professional). See ``chat_routes.lead_capture_endpoint``.
    utm_params = Column(JSONB, nullable=True)
    visitor_journey = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="lead_info")
    bot = relationship("Bot", back_populates="lead_infos")
    followup_sent_by = relationship("Operator")


class CompanyProfile(Base):
    """One resolved company per registrable domain, shared across ALL tenants.

    Deliberately not scoped to a client. It holds only public web data about a
    company, so there is nothing to leak between tenants, and sharing means a
    popular domain is crawled once for the whole platform instead of once per
    customer. The key is the registrable domain from
    ``domain_normalizer.registrable_domain``. Every employee of one company,
    on whatever mail subdomain, must collapse to a single row.

    Failures are cached too. A dead, parked, or bot-walled domain records
    ``resolution_failed`` with a ``retry_after`` backoff, so one bad domain
    costs a single crawl rather than one per lead arriving from it.
    """

    __tablename__ = "company_profile"

    # CITEXT, not String: this is the shared key, and Acme.com / acme.com
    # fragmenting into two rows means two crawls and two possibly-different
    # answers for one company. ``registrable_domain`` already lowercases, but
    # the type stops a future caller that forgets. Matches ``ReferralCode.code``.
    domain = Column(CITEXT, primary_key=True)
    name = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    logo_url = Column(String, nullable=True)

    resolution_failed = Column(Boolean, nullable=False, server_default="false")
    # Set only when resolution_failed. Gates re-crawl attempts.
    retry_after = Column(DateTime(timezone=True), nullable=True)
    # Consecutive failures, so backoff can grow. ``retry_after`` alone cannot
    # encode attempt depth, which would leave a permanently-dead domain
    # re-crawled at a fixed rate forever, the per-domain cost leak this table
    # exists to prevent, merely slowed.
    failure_count = Column(Integer, nullable=False, server_default="0")
    # Lazy refresh horizon for a SUCCESSFUL profile.
    refresh_after = Column(DateTime(timezone=True), nullable=True)

    # Provenance. Every tenant reads this row, so a regressed extractor or a
    # bad prompt must be invalidatable surgically ("DELETE WHERE source='llm'")
    # rather than by truncating the whole platform's cache.
    source = Column(String, nullable=True)  # "markup" | "llm"
    resolved_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # NOTE app-side only, like every other model here, a raw UPDATE will not
    # bump it. The likely future writer is a bulk "refresh stale rows" sweep,
    # which must set this explicitly.
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        # A btree PK errors above ~2704 bytes, and an empty key is meaningless.
        CheckConstraint(
            "length(domain) BETWEEN 1 AND 253",
            name="chk_company_profile_domain_length",
        ),
        # The two sweeps this table implies (refresh stale, retry failed)
        # would otherwise be full scans as the cache grows.
        Index(
            "ix_company_profile_refresh_due",
            "refresh_after",
            postgresql_where=text("NOT resolution_failed"),
        ),
        Index(
            "ix_company_profile_retry_due",
            "retry_after",
            postgresql_where=text("resolution_failed"),
        ),
    )


class ChatSession(Base):
    __tablename__ = "chat_sessions"
    id = Column(String, primary_key=True)
    # Legacy FK. Kept during migration transition. Indexed (audit F27): every
    # analytics query filters chat_sessions by client_id when bot_id is absent.
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=True, index=True)
    # New FK. Primary association
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=True)

    location = Column(String, nullable=True)
    device = Column(String, nullable=True)

    # Behavioral scoring
    behavioral_score = Column(Integer, default=0, server_default="0", nullable=False)
    page_url = Column(String, nullable=True)
    referrer = Column(String, nullable=True)
    utm_params = Column(JSONB, nullable=True)
    # Ordered list of ``{"path": "/services", "ts": "2026-07-09T12:00:15Z"}``
    # entries the widget recorded as the visitor moved between pages on
    # the host site before opening the chat. Written once from
    # ``/chat/behavioral-signals``. First payload with a non-empty journey
    # wins so later "just before opening chat" navigations don't overwrite
    # the earlier top-of-funnel context.
    visitor_journey = Column(JSONB, nullable=True)
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
    # duplicate card rendering across turns, the LLM cannot enforce
    # "at most once per conversation" on its own.
    inline_cards_shown = Column(JSONB, nullable=True)
    visitor_rating = Column(Integer, nullable=True)  # Post-chat satisfaction: 1 to 5, null = not rated
    visitor_resolved = Column(Boolean, nullable=True)  # Post-chat: was the issue resolved? null = not answered

    # Unread-leads tracking: NULL = unread in the /leads admin view.
    # Backed by partial index ix_chat_sessions_bot_id_lead_viewed_at
    # (see migration d4e5f6a7b8c9) to keep sidebar polling cheap.
    lead_viewed_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # No `onupdate=func.now()` here on purpose: that fires on ANY UPDATE to
    # this row (e.g. marking a lead viewed, editing notes/tags), not just
    # real visitor activity, which made "Last Active" jump every time an
    # admin opened a lead. Genuine activity explicitly bumps this in
    # `ensure_chat_session` (repository.py) on each visitor chat turn.
    last_active_at = Column(DateTime(timezone=True), server_default=func.now())

    client = relationship("Client", back_populates="chat_sessions", foreign_keys=[client_id])
    bot = relationship("Bot", back_populates="chat_sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    lead_info = relationship("LeadInfo", back_populates="session", uselist=False, cascade="all, delete-orphan")
    assigned_operator = relationship("Operator", back_populates="active_sessions")
    bant_signals = relationship("BANTSignal", back_populates="session", cascade="all, delete-orphan")
    visitor_events = relationship("VisitorEvent", back_populates="session", cascade="all, delete-orphan")

    __table_args__ = (
        # Bot-scoped session listing/analytics filter by bot_id and sort by
        # created_at DESC (visitor list, dashboard stats, top-questions, etc.).
        # ``client_id`` is already indexed but is the legacy owner filter;
        # ``_session_owner_filter`` keys on bot_id first. Without this the
        # dashboard sequentially scans + filesorts chat_sessions. Composite
        # (bot_id, created_at DESC) serves both. See migration e1f2a3b4c5d6.
        Index(
            "ix_chat_sessions_bot_id_created",
            "bot_id",
            created_at.desc(),
        ),
    )


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
    source = Column(String, default="llm", server_default="llm", nullable=False)  # llm|cta_click|operator_override
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


class ActivationEvent(Base):
    """Onboarding activation milestones emitted by a client account.

    Unlike ``BotGrowthEvent`` (which restricts ``event_type`` to a fixed set),
    ``event_type`` here is intentionally free-form so new activation milestones
    can be added without a schema/constraint change. Rows are best-effort
    instrumentation, scoped to the emitting client (optionally a specific bot).
    """

    __tablename__ = "activation_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), index=True, nullable=False)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True)
    event_type = Column(String, nullable=False, index=True)  # free-form; NO CheckConstraint
    event_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


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
    """Live chat operator, a team member who can handle customer conversations."""

    __tablename__ = "operators"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False)
    is_online = Column(Boolean, default=False, server_default="false", nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    # Manual DND toggle. Operator can stay "online" (WS connected) but stop
    # accepting new chat assignments. Independent of is_online so capacity
    # planning can distinguish "off shift" from "busy with admin tasks".
    is_accepting_chats = Column(Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Auth credentials (for separate operator login)
    hashed_password = Column(String, nullable=True)
    operator_api_key = Column(String, unique=True, index=True, nullable=True)
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)

    # Bot binding, one operator, one bot. See migration
    # ``b1c7e9d3f2a5_operator_bot_one_to_one.py`` for the schema change and the
    # backfill that picked each workspace's oldest bot for pre-existing rows.
    # Live-chat routing scopes every assignment to this bot so an operator on
    # Bot A never gets a Bot B conversation delivered.
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False, index=True)

    # Role & department
    role = Column(String, default="operator", server_default="operator", nullable=False)  # owner|admin|operator
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)

    # Profile & settings
    avatar_url = Column(String, nullable=True)
    max_concurrent_chats = Column(Integer, default=5, server_default="5", nullable=False)
    notification_preferences = Column(JSONB, nullable=True)

    # Linked-identity fields. Populated when an operator was created via an
    # invite the invitee accepted while authenticated as a Client.
    # ``linked_client_id`` points at that underlying Client identity, so the
    # auth resolver can grant operator capabilities to a caller presenting the
    # Client's ``X-API-Key`` together with the workspace's ``X-Workspace-Id``.
    # NULL for legacy operators (created with their own password via
    # ``POST /operators/create``). They authenticate via ``X-Operator-Key``
    # and continue to work unchanged.
    linked_client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    # Historic snapshot of the email the invite was sent to. Preserved even if
    # the linked Client's email later changes so we can audit "who accepted
    # this invite" against the invite email at the moment of acceptance.
    invited_email = Column(String, nullable=True)

    client = relationship("Client", foreign_keys=[client_id])
    linked_client = relationship("Client", foreign_keys=[linked_client_id])
    department = relationship("Department", back_populates="operators")
    active_sessions = relationship("ChatSession", back_populates="assigned_operator")

    __table_args__ = (
        # A given Client identity may hold at most ONE operator role per
        # workspace. Legacy operators (linked_client_id IS NULL) are excluded
        # from this constraint so multiple pre-invite-model rows in the same
        # workspace can coexist during the migration period.
        Index(
            "ux_operators_linked_per_workspace",
            "client_id",
            "linked_client_id",
            unique=True,
            postgresql_where=sqlalchemy.text("linked_client_id IS NOT NULL"),
        ),
    )


class OperatorInvite(Base):
    """Invitation for a person to join a workspace as an operator.

    Lifecycle
    ---------
    * **pending**. Created by an owner or admin, email sent, token unused.
    * **accepted**. Invitee authenticated (as a new or existing Client) and
      accepted the invite; a linked Operator row was created in the target
      workspace.
    * **revoked**. Owner or admin cancelled the invite before acceptance.
    * **expired**. ``expires_at`` passed with no acceptance. A sweep task or
      lazy check flips the status.

    Security
    --------
    Only ``token_hash`` (SHA-256 of the raw invite token) is stored, the
    plaintext token appears exactly once in the invite email link. Timing-safe
    equality is used at lookup so token verification doesn't leak length via
    string comparison shortcuts.
    """

    __tablename__ = "operator_invites"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Workspace being invited to, the owner's client_id also IS the workspace ID.
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Bot the invitee will operate. Operators are strictly bot-scoped
    # (``Operator.bot_id`` is NOT NULL), so acceptance MUST know which bot to
    # bind the new Operator to, the invite carries that binding end to end.
    # Seat limits are enforced per-bot; the invite modal, create/accept service
    # paths, and the invite list (filtered by bot in the UI) all key off this.
    # ``ON DELETE CASCADE`` mirrors ``operators.bot_id``: deleting a bot voids
    # any invite that would only have provisioned an operator for it.
    bot_id = Column(
        Integer,
        ForeignKey("bots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Target email. Always stored lowercased. Uniqueness of pending invites is
    # enforced by the partial index below.
    email = Column(String, nullable=False, index=True)

    # Role and department the invitee will get on acceptance.
    role = Column(String, nullable=False, default="operator", server_default="operator")
    department_id = Column(
        Integer,
        ForeignKey("departments.id", ondelete="SET NULL"),
        nullable=True,
    )

    # SHA-256 hex digest of the raw invite token. 64 chars → String(64).
    token_hash = Column(String(64), unique=True, nullable=False, index=True)

    # Lifecycle enum. Validated at the application layer since the set of
    # valid states may grow (e.g. ``resent``, ``forwarded``) and inline enums
    # are painful to migrate. Server-default keeps DB inserts consistent.
    status = Column(
        String,
        nullable=False,
        default="pending",
        server_default="pending",
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Audit, who invited whom, when it resolved.
    invited_by_client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Snapshot of the inviter's display name at creation time so a later name
    # change on the inviter's Client row doesn't retroactively rewrite the
    # invite email content.
    invited_by_name = Column(String, nullable=True)

    accepted_at = Column(DateTime(timezone=True), nullable=True)
    accepted_by_client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )

    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by_client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Delivery tracking. Timestamp of the most recent send + how many resends.
    # Rate-limits the resend endpoint.
    sent_at = Column(DateTime(timezone=True), nullable=True)
    resend_count = Column(Integer, default=0, server_default="0", nullable=False)

    workspace = relationship("Client", foreign_keys=[client_id])
    invited_by = relationship("Client", foreign_keys=[invited_by_client_id])
    accepted_by = relationship("Client", foreign_keys=[accepted_by_client_id])
    revoked_by = relationship("Client", foreign_keys=[revoked_by_client_id])
    department = relationship("Department", foreign_keys=[department_id])

    __table_args__ = (
        # At most one PENDING invite per (workspace, email). Accepted / revoked
        # / expired rows are retained for audit and don't collide.
        Index(
            "ux_operator_invites_pending_unique",
            "client_id",
            "email",
            unique=True,
            postgresql_where=sqlalchemy.text("status = 'pending'"),
        ),
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)  # user|bot|operator|system
    content = Column(Text, nullable=False)
    feedback = Column(Integer, nullable=True)
    # True on a bot turn that could NOT be answered from the knowledge base
    # (the "no-info pivot": relevance gate fired on an on-scope question, or
    # retrieval returned nothing). Powers the Knowledge-gaps analytics. Each
    # flagged bot message is paired with its preceding user question. Indexed
    # because the analytics query filters on it.
    is_unanswered = Column(Boolean, default=False, server_default="false", nullable=False, index=True)
    trace_id = Column(String(255), nullable=True)  # Langfuse trace ID for feedback linking
    # Media-card payloads emitted alongside a bot answer. The sentinels
    # ([YOUTUBE_CARD:…] / [DOWNLOAD_CARD:…]) are stripped from ``content`` at
    # save time by ``_extract_media_card``; persisting the parsed card here
    # is what lets the widget re-render the video/document card after a
    # refresh, instead of showing only the text answer.
    # Shape (media_card): {"type": "youtube", "video_id": "..."} |
    #                     {"type": "download", "url": "...", "name": "..."}
    # Shape (media_secondary): list of ≤1 same-shaped payloads (the
    # opposite-type "Also available" chip). Nullable so historical rows
    # and card-less answers stay valid.
    media_card = Column(JSONB, nullable=True)
    media_secondary = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="messages")

    __table_args__ = (
        # Hot path: every chat turn loads recent history for a session
        # (``WHERE session_id = ? ORDER BY created_at DESC LIMIT n``) and all
        # per-session analytics join on session_id. Without this the query
        # sequentially scans the whole (fastest-growing) table. Confirmed on
        # prod via EXPLAIN and re-measured at 588× faster on 1.1M rows.
        # Composite (session_id, created_at DESC) serves both the filter and
        # the sort from the index. See migration e1f2a3b4c5d6.
        Index(
            "ix_chat_messages_session_id_created",
            "session_id",
            created_at.desc(),
        ),
    )


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
    keep positions densely packed. Dequeue_reason marks exits and a daily
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
    """Pricing plan tier. Fully configurable from the super admin panel."""

    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)  # "Free", "Starter", "Standard", "Professional"
    slug = Column(String, unique=True, index=True, nullable=False)  # "free", "starter", "standard", "professional"
    description = Column(Text, nullable=True)

    # Pricing (stored in *minor units* of the configured currency (paise for
    # INR, cents for USD) to avoid floating-point issues). The historical
    # column name ``*_cents`` is retained for compatibility; treat it as
    # "minor units of ``currency`` field" in new code.
    pricing_model = Column(
        String, default="per_operator", server_default="per_operator", nullable=False
    )  # per_operator|flat|custom
    currency = Column(String(3), default="INR", server_default="INR", nullable=False)
    monthly_price_cents = Column(Integer, default=0, server_default="0", nullable=False)
    annual_price_cents = Column(Integer, default=0, server_default="0", nullable=False)  # total annual price
    # DERIVED, never authored. Every writer (super-admin plan CRUD,
    # scripts/seed_plans.py) computes this from the two INR prices above via
    # ``core.pricing.annual_saving_percent``, and NO read path serves it, the
    # plan payloads derive the percent from the prices they are already
    # returning. It is kept in sync so the table does not contradict the API,
    # but it is not a source of truth, and the stale ``30`` defaults below
    # (retained to avoid a schema migration here) can no longer reach a customer.
    annual_discount_percent = Column(Integer, default=30, server_default="30", nullable=False)

    # Trial. Default 7 = the Standard-only free-trial length; seed_plans sets
    # trial_days per tier (Standard 7, all others 0. Trials are Standard-only).
    trial_days = Column(Integer, default=7, server_default="7", nullable=False)

    # Usage limits. JSONB allows flexible addition of new limit types without migrations
    limits = Column(
        JSONB,
        nullable=False,
        server_default='{"ai_messages": 250, "url_scans": 50, "live_chat_messages": 0, "email_summaries": 0, "email_notifications": 0, "knowledge_pages": 50, "knowledge_characters": 2500, "storage_mb": 5, "chat_history_days": 7}',
    )

    # Feature flags, which features are available on this plan
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

    # Razorpay integration
    razorpay_plan_id_monthly = Column(String, nullable=True)
    razorpay_plan_id_annual = Column(String, nullable=True)

    # Razorpay plan IDs for the USD (international) rail. Separate Razorpay
    # plans priced in USD, a plan's currency is fixed at creation, so the INR
    # ids above cannot serve a USD charge. NULL means the USD rail is not
    # configured for this tier and USD checkout must fail loudly rather than
    # silently charging INR. Per-environment (test vs live), like the INR ids.
    razorpay_plan_id_monthly_usd = Column(String, nullable=True)
    razorpay_plan_id_annual_usd = Column(String, nullable=True)

    # Fixed USD headline pricing (cents). Independent of the INR columns.
    # Set deliberately, NEVER converted live. Shown to non-Indian visitors.
    # NULL → caller falls back to a DISPLAY_USD_TO_INR conversion for legacy
    # rows that predate these columns. See ``app.core.pricing.display_price``
    # and ADR D2/D3 in the billing plan.
    monthly_price_usd_cents = Column(Integer, nullable=True)
    annual_price_usd_cents = Column(Integer, nullable=True)
    extra_seat_price_usd_cents = Column(Integer, nullable=True)

    # Display & ordering
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    is_default = Column(Boolean, default=False, server_default="false", nullable=False)  # auto-assigned to new clients
    sort_order = Column(Integer, default=0, server_default="0", nullable=False)

    # Marketing / display copy for the public pricing site (tagline, badge,
    # CTA, highlight bullets, featured flag). JSONB so new display fields need
    # no migration. Consumed by GET /public/pricing-catalog.
    marketing = Column(
        JSONB,
        nullable=False,
        server_default="{}",
    )

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


class Promotion(Base):
    """A time-boxed acquisition campaign. E.g. "sign up this month, 3 months free".

    Config lives in a row (not code) so a super admin can launch, pause, and
    expire an offer without a deploy. ``is_active`` is the pause switch; the
    signup window is ``[starts_at, ends_at]``; ``free_cycles`` billing periods
    are granted at 100% off via a deferred Razorpay ``start_at`` (the first real
    charge lands ``free_cycles`` months after the mandate is authorised).

    Entitlements always follow the subscription's ``plan_id``, the promo only
    defers *billing*, never access.
    """

    __tablename__ = "promotions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Optional human code for a shareable link (``?code=LAUNCH3``). NULL = a
    # pure date-window offer with no code. Unique when present.
    code = Column(String, unique=True, index=True, nullable=True)
    name = Column(String, nullable=False)

    # The pause switch. Flip to false to stop new redemptions instantly,
    # without deleting the campaign or touching subscriptions already on it.
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)

    # Signup window. A client is eligible only when created within
    # ``[starts_at, ends_at]`` AND the offer is resolved during that window.
    starts_at = Column(DateTime(timezone=True), nullable=False)
    ends_at = Column(DateTime(timezone=True), nullable=False)

    # Free billing periods granted at 100% off before the first real charge.
    free_cycles = Column(Integer, default=3, server_default="3", nullable=False)

    # NULL = every active paid plan is eligible. Otherwise a JSON array of
    # ``Plan.id`` the offer applies to (e.g. monthly-only tiers).
    eligible_plan_ids = Column(JSONB, nullable=True)

    # Optional hard cap. NULL = uncapped (the launch default). When set,
    # redemptions are gated by an atomic guarded increment on ``redeemed_count``
    # so concurrent checkouts can never oversell the cap.
    max_redemptions = Column(Integer, nullable=True)
    redeemed_count = Column(Integer, default=0, server_default="0", nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("ends_at > starts_at", name="ck_promotions_window_order"),
        CheckConstraint("free_cycles > 0", name="ck_promotions_free_cycles_positive"),
        CheckConstraint(
            "max_redemptions IS NULL OR max_redemptions > 0",
            name="ck_promotions_max_redemptions_positive",
        ),
    )


class Subscription(Base):
    """Links a Client to a Plan. Tracks billing state and payment provider details."""

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
    # The billing period (by ``current_period_end``) the plan's monthly credits
    # were last granted for. Makes the renewal grant idempotent per period.
    # ``subscription.charged`` / ``activated`` grant at most once per distinct
    # period regardless of event timing, ordering, or replays (remediation H4).
    last_granted_period_end = Column(DateTime(timezone=True), nullable=True)

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
    # Idempotency log for the dunning cadence, mirroring ``trial_emails_sent``.
    # Keys are cadence stages (``failed_0``, ``halted_3``, ``warning_5``,
    # ``suspended``); values are ISO-8601 send timestamps. Missing key == not
    # yet sent, so every cron re-run is safe.
    #
    # Deliberately NOT reusing ``trial_emails_sent``: the two lifecycles are
    # independent, and a customer who recovers, later churns, and returns must
    # get a fresh dunning sequence without their trial history being cleared.
    dunning_emails_sent = Column(JSONB, nullable=False, server_default="{}", default=dict)

    # Cancellation
    canceled_at = Column(DateTime(timezone=True), nullable=True)
    cancel_reason = Column(Text, nullable=True)
    # Reversible customer INTENT to churn at period end, not a gateway fact.
    # ``/subscriptions/cancel`` sets it and touches nothing at Razorpay, so the
    # customer can change their mind for free right up until the sweep below
    # runs. Cleared by ``/subscriptions/resume`` while the mandate is still live.
    cancel_at_period_end = Column(Boolean, default=False, server_default="false", nullable=False)
    # When the IRREVERSIBLE Razorpay cancel was actually issued for this row.
    # Razorpay has no un-cancel, so this is the line between "reactivating is a
    # free flag flip" (NULL) and "reactivating needs a fresh mandate + checkout"
    # (set). ``task_execute_pending_cancellations`` stamps it a couple of days
    # before ``current_period_end``; ``/cancel`` stamps it inline when the
    # customer cancels inside that window. Also stamped defensively by
    # ``/resume`` when the gateway reports a mandate we believed was live.
    gateway_cancel_executed_at = Column(DateTime(timezone=True), nullable=True)

    # The Razorpay plan actually billed against, a discounted plan when a
    # referral code applied, else identical to the base plan's razorpay id.
    # Entitlements always follow plan_id (the base plan). NULL for legacy rows
    # that predate the discount engine.
    razorpay_billing_plan_id = Column(String, nullable=True)

    # ── Launch-promo (deferred-charge free period) ──────────────────────────
    # Set when this subscription was created under a Promotion. Entitlements
    # still follow ``plan_id``; the promo only defers the first charge. SET NULL
    # on promotion delete so billing history survives a campaign cleanup.
    promotion_id = Column(Integer, ForeignKey("promotions.id", ondelete="SET NULL"), nullable=True)
    # The moment the free period ends and the first real charge lands. Mirrors
    # the Razorpay subscription ``start_at``. NULL for non-promo subscriptions.
    promo_free_until = Column(DateTime(timezone=True), nullable=True)
    # Idempotency log for promo reminder emails (keys e.g. ``pre_charge``),
    # mirroring ``trial_emails_sent``. Missing key == not yet sent, so the
    # reminder cron re-runs safely.
    promo_reminder_sent = Column(JSONB, nullable=False, server_default="{}", default=dict)

    # Payment provider IDs
    payment_provider = Column(String, default="razorpay", server_default="razorpay", nullable=False)  # razorpay|manual
    razorpay_subscription_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_customer_id = Column(String, index=True, nullable=True)
    # Set when a paid→paid transition replaces an existing Razorpay mandate.
    # The activation handler reads this to distinguish a "this is the second
    # subscription in a plan-change" event from a fresh first-time signup.
    prev_razorpay_subscription_id = Column(String, nullable=True)

    # Scheduled plan change. Populated when a paid→paid downgrade is queued
    # for cutover at the end of the current billing cycle. The cron + the
    # gateway's ``subscription.completed`` webhook both check these columns;
    # whichever fires first promotes the change and clears the trio.
    scheduled_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)
    scheduled_billing_cycle = Column(String(16), nullable=True)
    scheduled_change_at = Column(DateTime(timezone=True), nullable=True)
    # Proration value (plan-currency cents) for unused time on the previous
    # plan. Applied as a credit-ledger ``topup`` once the new subscription's
    # ``activated`` webhook confirms payment cleared. Zero means no pending
    # credit, never NULL so arithmetic stays simple.
    upgrade_credit_pending_cents = Column(Integer, default=0, server_default="0", nullable=False)

    # Finding D: idempotency marker for an in-flight paid→paid upgrade checkout.
    # Set on the OLD sub when execute_paid_upgrade mints the new (not-yet-local)
    # Razorpay subscription; a sequential double-submit for the SAME target plan
    # returns this existing checkout instead of minting a second sub (which would
    # double-charge the first cycle). Cleared when the upgrade activates.
    upgrade_pending_subscription_id = Column(String, nullable=True)
    upgrade_pending_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True)

    # Razorpay id of the SEPARATE per-seat add-on subscription. Kept distinct
    # from razorpay_subscription_id because Razorpay quantity multiplies the
    # whole plan amount. Seats must be their own sub (P0-3).
    seat_addon_subscription_id = Column(String, nullable=True)
    seat_addon_quantity = Column(Integer, nullable=False, server_default="0")
    # Finding A: extra seats DESIRED on a first purchase, awaiting mandate
    # authorization. Entitlement (operator_quantity) is NOT granted until the
    # seat add-on's ``activated`` webhook confirms the mandate. Otherwise seats
    # run free before Razorpay ever charges. NULL = nothing pending. Distinct
    # from seat_addon_quantity (the AUTHORIZED/billed count).
    seat_addon_pending_quantity = Column(Integer, nullable=True)

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
    promotion = relationship("Promotion")
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
        # concurrently, one per bot they pay for.
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
    """Monthly usage tracking per client. Reset at the start of each billing period."""

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
    """Payment history. Synced from Razorpay via webhooks."""

    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True)
    # Ledger scope this payment credited: the bot's isolated ledger when set,
    # else the client pool (NULL). Recorded so a refund claws credits back from
    # the SAME scope it granted them to (remediation C2).
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)

    # Amount
    amount_cents = Column(BigInteger, nullable=False)
    currency = Column(String, default="inr", server_default="inr", nullable=False)
    status = Column(String, default="pending", server_default="pending", nullable=False)  # paid|pending|failed|refunded
    # Cumulative refunded amount (minor units) across ALL refund events for this
    # charge. Accumulated per refund event (deduped on refund id) so the status
    # flips to "refunded" once several PARTIAL refunds sum to the full charge,
    # instead of staying "partially_refunded" forever (finding #5).
    refunded_minor = Column(BigInteger, default=0, server_default="0", nullable=False)

    # Provider references
    razorpay_payment_id = Column(String, unique=True, index=True, nullable=True)

    # Links
    invoice_url = Column(String, nullable=True)  # Hosted invoice page URL
    pdf_url = Column(String, nullable=True)  # PDF download URL

    # Billing period this invoice covers
    period_start = Column(DateTime(timezone=True), nullable=True)
    period_end = Column(DateTime(timezone=True), nullable=True)

    # Description for line items (e.g. "Starter Plan - Monthly" or "Overage: 500 messages")
    description = Column(Text, nullable=True)

    # What this charge was FOR. Drives refund/dispute clawback routing (P0-1):
    #   plan_charge     → funded a plan_grant (claw that grant)
    #   topup           → funded a topup grant (claw that grant)
    #   seat            → operator seat add-on; funded NO credit grant
    #   withheld_charge → charged after cancellation; credits were withheld
    # NULL = legacy row predating the column; only those may use the
    # most-recent-grant clawback fallback (see credit_service.clawback_refund).
    kind = Column(String(16), nullable=True)

    paid_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # ── Invoicing v2: legal tax-document fields (nullable. Rows created
    # before v2, or while INVOICING_V2_ENABLED is off, stay 'legacy' and are
    # excluded from GST exports; never retro-taxed). Finalized documents are
    # IMMUTABLE. Corrections are credit notes, never edits.
    # 20 chars (> the 16-char Rule 46 minimum) leaves headroom for a longer
    # prefix or a 7-digit serial without a hard ceiling once numbers are issued.
    invoice_number = Column(String(20), unique=True, index=True, nullable=True)
    invoice_type = Column(
        String, nullable=False, default="legacy", server_default="legacy"
    )  # tax_invoice|credit_note|receipt|legacy
    issued_at = Column(DateTime(timezone=True), nullable=True)
    seller_snapshot = Column(JSONB, nullable=True)  # legal identity at issue time
    buyer_snapshot = Column(JSONB, nullable=True)
    place_of_supply = Column(String(2), nullable=True)  # GST state code
    supply_kind = Column(String, nullable=True)  # intra|inter|export
    taxable_value_minor = Column(BigInteger, nullable=True)
    tax_rate_bps = Column(Integer, nullable=True)
    cgst_minor = Column(BigInteger, nullable=True)
    sgst_minor = Column(BigInteger, nullable=True)
    igst_minor = Column(BigInteger, nullable=True)
    total_tax_minor = Column(BigInteger, nullable=True)
    hsn_sac = Column(String(8), nullable=True)
    is_export = Column(Boolean, nullable=False, default=False, server_default="false")

    # ── INR mirror for a non-INR (export) document ───────────────────────────
    # The document is issued in the currency of supply; GST is REPORTED in
    # rupees (GSTR-1 Table 6A), and IGST on an export made without a LUT is
    # remitted in rupees. These carry that mirror so the return never has to
    # re-derive a rate years later. All NULL on an INR invoice, where
    # ``amount_cents``/``taxable_value_minor`` are already the reportable
    # figures.
    #
    # ``inr_amount_minor`` is Razorpay's ``base_amount`` verbatim (the paise
    # it actually converted and settles on) so the document ties to the
    # settlement and the FIRC exactly. The rate is stored alongside it (INR per
    # one foreign unit, x1e6, integer, never a float on a statutory record)
    # purely so the arithmetic is reproducible on the face of the invoice.
    inr_amount_minor = Column(BigInteger, nullable=True)
    inr_taxable_value_minor = Column(BigInteger, nullable=True)
    inr_total_tax_minor = Column(BigInteger, nullable=True)
    fx_rate_micros = Column(BigInteger, nullable=True)
    fx_rate_source = Column(String(32), nullable=True)  # razorpay_base_amount
    line_items = Column(JSONB, nullable=True)
    credit_note_of_id = Column(Integer, ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True)
    # Razorpay's own invoice entity for this charge (payment.invoice_id from
    # the subscription.charged payload). Payment evidence, not the tax doc.
    razorpay_invoice_id = Column(String, index=True, nullable=True)
    # Last time the document email was sent to the buyer. The PDF sweep only
    # auto-emails when NULL, so an admin "regenerate PDF" can never re-email
    # the customer; superadmin resend updates it.
    emailed_at = Column(DateTime(timezone=True), nullable=True)
    # Recovery-sweep claim marker (NOT delivery). ``emailed_at`` means the send
    # RETURNED; this is stamped before the attempt so overlapping sweeps can't
    # double-send, and a stale claim (crashed worker) is re-swept after 1h.
    email_claimed_at = Column(DateTime(timezone=True), nullable=True)
    # E-invoicing (IRP). Unused until the ₹5cr B2B threshold applies.
    irn = Column(String, nullable=True)
    signed_qr = Column(Text, nullable=True)

    client = relationship("Client")
    subscription = relationship("Subscription", back_populates="invoices")


# Finding L: once an invoice is numbered it IS a legal document, its tax and
# identity columns must never change. Immutability was previously convention-only
# (finalize simply refused to re-run), so any later code path could still mutate a
# frozen row and only arithmetic-inconsistent tampering would be caught by
# reconciliation. This DB-session guard rejects mutation of every frozen column on
# a numbered invoice, allowing ONLY delivery/lifecycle fields (PDF/email/e-invoice
# registration/payment status). The finalize transition itself (invoice_number
# going NULL→value in the same UPDATE) is allowed.
_INVOICE_FROZEN_EXEMPT = frozenset(
    # refunded_minor accompanies the ``status`` transition (partially_refunded /
    # refunded), a post-issuance lifecycle field, not a frozen tax/amount column.
    # ``kind`` is clawback-routing metadata, not part of the legal document; the
    # charged handler stamps withheld_charge AFTER the invoice is finalized
    # (the withhold decision happens later in the same handler).
    {
        "pdf_url",
        "invoice_url",
        "emailed_at",
        "email_claimed_at",
        "status",
        "refunded_minor",
        "irn",
        "signed_qr",
        "razorpay_invoice_id",
        "kind",
    }
)


@sqlalchemy.event.listens_for(Invoice, "before_update")
def _reject_frozen_invoice_mutation(mapper, connection, target):  # noqa: ANN001
    state = sqlalchemy.inspect(target)
    # If invoice_number is being assigned in THIS update, it's the finalize
    # transition (finalize writes the number + all tax columns together). Allow
    # it. Enforcement only applies once a row is numbered and the number is NOT
    # changing (i.e. a later edit to an already-finalized document).
    if state.attrs.invoice_number.history.has_changes():
        return
    if target.invoice_number is None:
        return  # never finalized (legacy row). Freely mutable
    changed = [
        col.key
        for col in mapper.column_attrs
        if col.key not in _INVOICE_FROZEN_EXEMPT and state.attrs[col.key].history.has_changes()
    ]
    if changed:
        raise ValueError(
            f"Invoice {target.invoice_number} is finalized; refusing to mutate "
            f"frozen column(s): {', '.join(sorted(changed))}"
        )


class InvoiceCounter(Base):
    """Gapless per-FY invoice serial allocator.

    One row per (financial_year, prefix); the finalize service increments
    ``last_serial`` under ``SELECT … FOR UPDATE`` so concurrent webhooks get
    consecutive numbers and abandoned payments burn none (serials are only
    allocated at finalize time, a Rule 46 audit requirement).

    ``updated_at`` uses SQLAlchemy ``onupdate`` (app-side), so the Phase 2
    allocator must mutate ``last_serial`` through the ORM for the timestamp to
    stay honest, a raw ``UPDATE`` would not bump it.
    """

    __tablename__ = "invoice_counters"

    financial_year = Column(String(5), primary_key=True)  # e.g. "25-26"
    prefix = Column(String(3), primary_key=True)
    last_serial = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PaymentMethod(Base):
    """A saved payment instrument, a DISPLAY MIRROR of Razorpay's token list.

    Razorpay is the source of truth (``GET /v1/customers/{id}/tokens``); this
    table exists so the app and the super-admin console can render an
    instrument list without a live gateway call, and so a revoked token can be
    pruned the moment its webhook lands.

    RBI card-on-file rules permit a merchant to retain ONLY the last four
    digits, the network, and issuer metadata. Cardholder name, BIN/IIN and
    **expiry** must not be stored after 1 Oct 2022. Hence no expiry columns
    here. Anything richer has to be fetched live and discarded; if you find
    yourself adding a column for it, that is the bug.
    """

    __tablename__ = "payment_methods"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    provider = Column(String, nullable=False, default="razorpay", server_default="razorpay")
    type = Column(String, nullable=False)  # card|upi|emandate
    last4 = Column(String(4), nullable=True)
    network = Column(String, nullable=True)  # Visa|MasterCard|RuPay|Amex
    issuer = Column(String, nullable=True)  # bank code, e.g. HDFC
    upi_handle = Column(String, nullable=True)  # VPA, for mandate display

    is_default = Column(Boolean, default=False, server_default="false", nullable=False)

    # Provider references
    razorpay_token_id = Column(String, unique=True, index=True, nullable=True)
    # Provenance only, which gateway customer this token came from. Not
    # indexed: reads go via client_id or token id, both already indexed.
    razorpay_customer_id = Column(String, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # Last time this row was reconciled against Razorpay. Drives the read-through
    # TTL so the Billing page does not make a gateway call on every load.
    synced_at = Column(DateTime(timezone=True), nullable=True)

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
    # REPORTING ONLY. Deliberately *not* a second scope key. ``bot_id`` above
    # answers "which ledger does this row live in?"; this answers "which bot
    # spent it?". The two diverge whenever credits are pooled: a pooled
    # account's deductions all land in the client pool (``bot_id IS NULL``),
    # so without this column per-bot spend is simply not recoverable, and it
    # cannot be backfilled after the fact, which is why the column exists
    # before the first pooled account does.
    #
    # ``reference_id`` is not a substitute: it is a polymorphic audit label
    # (bot_id / document_id / invoice_id depending on ``reason``), so it cannot
    # be grouped on without silently mixing id spaces.
    #
    # Balance maths MUST keep keying off ``bot_id`` alone (``_scope_clause`` /
    # ``get_balance`` in credit_service). Summing on this column instead would
    # re-scope pooled deductions into per-bot ledgers and corrupt both the pool
    # balance and the per-bot one.
    attributed_bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)
    delta = Column(Integer, nullable=False)
    # The DB column is the native PG ENUM ``credit_reason``. The model MUST
    # declare it as such: with a plain String, a multi-row flush (a deduction
    # spanning two grants at a FIFO boundary. See credit_service.
    # check_and_deduct) goes through SQLAlchemy's insertmanyvalues path, which
    # binds the params as typed VARCHAR and Postgres rejects the enum insert
    # with DatatypeMismatch; the page TX then rolls back and every retry hits
    # the same boundary. Single-row inserts only ever worked via implicit cast.
    # Values mirror the live enum (c1d2e3f4a5b6 + d9e3c1b7a4f2 migrations).
    # Prod schema is alembic-managed (the type already exists there); the
    # default create_type=True only matters for metadata.create_all in the
    # throwaway-Postgres test fixtures, which need the type created with the
    # table.
    reason = Column(
        PG_ENUM(
            "plan_grant",
            "topup",
            "ai_chat",
            "url_scan",
            "email_send",
            "manual_adjust",
            "refund",
            "expiry",
            "document_upload",
            "email_verification",
            "company_name",
            name="credit_reason",
        ).with_variant(String(), "sqlite"),
        nullable=False,
    )
    reference_id = Column(Integer, nullable=True)  # coarse AUDIT label: bot_id / document_id / invoice_id
    # Finding H: opt-in, globally-unique idempotency token for a billable unit of
    # work. Only the crawl ingestion path sets one today
    # ("ingest:{client}:{bot}:{job}:{url_sha}"); NULL for every other/per-request
    # deduction. Backed by a partial unique index (see __table_args__).
    idempotency_key = Column(String, nullable=True)
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
        # Finding H: back the opt-in idempotency guard in check_and_deduct with a
        # partial unique index so a race that slips the app-level check still fails
        # closed. One deduction row per key; NULL keys (every legacy/per-request
        # deduction) are exempt, so existing callers are unaffected.
        Index(
            "uq_credit_ledger_idempotency_key",
            "idempotency_key",
            unique=True,
            postgresql_where=sqlalchemy.text("idempotency_key IS NOT NULL AND delta < 0"),
        ),
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
    """Idempotency log for Razorpay webhook event IDs.

    Webhook providers retry on 5xx and may deliver duplicates. We store the
    event ID on first successful processing; subsequent deliveries with the
    same ID are short-circuited with a 200 OK.
    """

    __tablename__ = "processed_webhooks"
    # Second dedup key (M-2): the HMAC covers only the BODY, the event id is a
    # header, a replayed signed body with a fresh id passes both checks
    # without this. Partial-unique (NULLs exempt) for legacy rows.
    __table_args__ = (
        Index(
            "uq_processed_webhooks_payload_digest",
            "payload_digest",
            unique=True,
            postgresql_where=text("payload_digest IS NOT NULL"),
        ),
    )

    event_id = Column(Text, primary_key=True)
    provider = Column(Text, nullable=False, index=True)  # 'razorpay'
    payload_digest = Column(Text, nullable=True)
    processed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class FailedWebhook(Base):
    """Dead-letter store for billing webhooks whose processing failed.

    When a verified Razorpay webhook raises during processing, the
    handler's transaction is rolled back (including the ``processed_webhooks``
    idempotency row), and the raw event is persisted here in a separate
    transaction so it survives that rollback. The provider is then asked to
    retry (5xx); this row is the backstop if every retry is exhausted.

    ``raw_payload`` keeps the **exact signed bytes** (not parsed JSON) so the
    ``X-Razorpay-Signature`` HMAC can be re-verified when the event is replayed.
    """

    __tablename__ = "failed_webhooks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider = Column(Text, nullable=False, index=True)  # 'razorpay'
    # Provider event id (``x-razorpay-event-id``); may be absent on some deliveries.
    event_id = Column(Text, nullable=True, index=True)
    event_type = Column(Text, nullable=True)  # e.g. 'payment.captured'
    raw_payload = Column(LargeBinary, nullable=False)  # exact bytes, for signature re-verify
    signature = Column(Text, nullable=True)  # X-Razorpay-Signature header at receipt time
    headers = Column(JSONB, nullable=True)  # selected headers captured for replay/debug
    error = Column(Text, nullable=True)  # repr of the exception that caused the failure
    # 'pending' (awaiting replay) | 'replayed' (successfully reprocessed) | 'ignored'.
    status = Column(Text, nullable=False, server_default="pending", default="pending")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    replayed_at = Column(DateTime(timezone=True), nullable=True)


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
# deferred to v2. See ``platform/docs/affiliate-program.md`` for details
# and the additive migration path. None of the columns here carry money;
# v2 will ADD columns to these same tables without rewriting existing data.


class Affiliate(Base):
    """Invite-only affiliate membership tied to a Client (0..1 per client).

    The presence of an active (``deactivated_at IS NULL``) row is the
    single source of truth for ``Client.is_affiliate``. Total active
    affiliates are capped at 5 by the service layer. There is no DB-level
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
    # pay out. Range enforced at the DB layer (0 to 10000 = 0 to 100%).
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
    # Redemption controls (remediation C3). ``max_redemptions`` NULL = unlimited;
    # ``redeemed_count`` is incremented atomically on each successful attribution;
    # ``valid_until`` NULL = no expiry. Without these a leaked code is an
    # unbounded, never-expiring discount liability.
    max_redemptions = Column(Integer, nullable=True)
    redeemed_count = Column(Integer, nullable=False, default=0, server_default="0")
    valid_until = Column(DateTime(timezone=True), nullable=True)
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
        CheckConstraint(
            "redeemed_count >= 0 AND (max_redemptions IS NULL OR max_redemptions >= 0)",
            name="chk_referral_redemption_counts",
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

    Stores hashed IP and UA only, never raw values. The hash salt rotates
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
    # Commission pool (bps) the super-admin set at invite time. Carried here so
    # the accept paths grant the affiliate the intended pool, without it an
    # invited affiliate landed at 0% and could create no earning code (NV4).
    commission_bps = Column(Integer, nullable=False, default=0, server_default="0")
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
    # Rail this cached plan bills on. Part of the dedup key: a Razorpay plan's
    # currency is fixed at creation, so the INR and USD discounted plans for the
    # same base/cycle/discount are different objects and must not share a row.
    # Sharing one would bill an international customer in rupees.
    currency = Column(String(3), default="INR", server_default="INR", nullable=False)
    razorpay_plan_id = Column(String, nullable=False)
    # Minor units in ``currency``. Paise for INR, cents for USD. The column
    # name predates the USD rail.
    amount_paise = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "base_plan_id",
            "billing_cycle",
            "discount_bps",
            "currency",
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
    what already-converted customers earn the affiliate. Snapshotting at
    subscribe time decouples live code edits from historical payouts.
    """

    __tablename__ = "referral_conversions"
    # One conversion per client, ever: the insert happens in the
    # subscription.charged webhook (which fires every cycle), and this
    # constraint is what makes replays and later cycles no-ops.
    __table_args__ = (UniqueConstraint("client_id", name="uq_referral_conversions_client"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    referral_code_id = Column(Integer, ForeignKey("referral_codes.id", ondelete="SET NULL"), nullable=True)
    affiliate_id = Column(Integer, ForeignKey("affiliates.id", ondelete="SET NULL"), nullable=True)
    commission_bps = Column(Integer, nullable=False)
    customer_discount_bps = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ReconciliationRun(Base):
    """One run of the daily gateway reconciliation (blueprint §7, Wave 3.5).

    ``report`` holds the structured deltas so the superadmin surface can show
    the latest run; the cron also ERROR-logs any delta for Sentry. Report
    data, not money. Rows are prunable.
    """

    __tablename__ = "reconciliation_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ran_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    window_from = Column(DateTime(timezone=True), nullable=False)
    window_to = Column(DateTime(timezone=True), nullable=False)
    delta_count = Column(Integer, nullable=False, server_default="0", default=0)
    report = Column(JSONB, nullable=False)


class BillingFunnelEvent(Base):
    """One detected drop-off in the payment funnel (Wave 3.0).

    The app already detects the customer closing the Razorpay sheet
    (``modal.ondismiss``) and gateway declines (``payment.failed``); this makes
    those signals operator-visible. Telemetry, not money: nothing downstream
    depends on these rows and they are safe to prune.
    """

    __tablename__ = "billing_funnel_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    # checkout_abandoned (customer closed the sheet) | payment_failed (gateway decline)
    event = Column(String(24), nullable=False)
    # plan | topup | seat | resume, which purchase surface opened the sheet
    surface = Column(String(12), nullable=False)
    meta = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


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
    attachment_url = Column(String, nullable=True)  # legacy single attachment (= attachments[0])
    category = Column(String, nullable=True)  # deprecated free-string; superseded by ``type``
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)

    # ── Taxonomy ─────────────────────────────────────────────────────────
    # Structured classification that replaces the free-string ``category``.
    type = Column(
        String(20),
        nullable=False,
        default="other",
        server_default="other",
        index=True,
    )  # bug | feature_request | question | other
    area = Column(
        String(20), nullable=True, index=True
    )  # billing | bots | knowledge | live_chat | dashboard | widget | other
    severity = Column(String(10), nullable=True)  # low | medium | high | critical. Bug-only
    context = Column(JSONB, nullable=True)  # {page_url, app_version, plan_tier, user_agent}
    attachments = Column(JSONB, nullable=True)  # [{url, name?, content_type?}]

    # ── Resolution loop ──────────────────────────────────────────────────
    # A superadmin can triage and resolve customer-submitted feedback; the
    # submitting client sees the status + written response back in the app.
    status = Column(
        String(20),
        nullable=False,
        default="open",
        server_default="open",
        index=True,
    )  # open | in_progress | resolved | closed
    admin_response = Column(Text, nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    resolved_by = Column(
        Integer,
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
    )

    client = relationship("Client", foreign_keys=[client_id])
    resolver = relationship("Client", foreign_keys=[resolved_by])


# ── Web Push subscriptions (operator notifications) ──────────────────────────


class OperatorPushSubscription(Base):
    """Web Push subscription for a dashboard user's browser/device.

    Despite the legacy table name (``operator_push_subscriptions``), this row
    can belong to either an **operator** (``operator_id`` set) or a workspace
    **owner / client** (``client_id`` set). Small teams where the owner takes
    chats themselves get push without needing a separate operator account.
    A DB-level CHECK constraint enforces that exactly one of the two FKs is
    populated; both branches are pruned on the same ``410 Gone`` rule.

    One subscriber can have many rows, one per browser/device they've
    granted permission on (laptop + work desktop + phone). The fan-out at
    handoff time sends to every row for every eligible recipient; first
    accept wins, the rest get a tagged follow-up that updates the on-device
    notification to "Claimed by X."
    """

    __tablename__ = "operator_push_subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    operator_id = Column(
        Integer,
        ForeignKey("operators.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String, nullable=False)
    auth = Column(String, nullable=False)
    # Optional device hint surfaced from the User-Agent at subscribe time.
    # Purely cosmetic (lets the user distinguish "Laptop Chrome" from
    # "iPhone Safari" when managing devices); not used in routing.
    user_agent = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # Updated on every successful push send. A long-stale ``last_used_at``
    # without a 410 isn't itself reason to prune (most providers keep
    # subscriptions valid for months), but it's useful telemetry.
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("endpoint", name="uq_operator_push_endpoint"),
        CheckConstraint(
            "((operator_id IS NULL)::int + (client_id IS NULL)::int) = 1",
            name="chk_push_subscription_owner_xor",
        ),
    )

    operator = relationship("Operator", foreign_keys=[operator_id])
    client = relationship("Client", foreign_keys=[client_id])


class OperatorExpoPushToken(Base):
    """Mobile Push subscription (Expo) for a user's mobile device."""

    __tablename__ = "operator_expo_push_tokens"

    id = Column(Integer, primary_key=True, autoincrement=True)
    operator_id = Column(
        Integer,
        ForeignKey("operators.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    token = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("token", name="uq_operator_expo_push_token"),
        CheckConstraint(
            "((operator_id IS NULL)::int + (client_id IS NULL)::int) = 1",
            name="chk_expo_push_token_owner_xor",
        ),
    )

    operator = relationship("Operator", foreign_keys=[operator_id])
    client = relationship("Client", foreign_keys=[client_id])


# ── In-app notifications (admin dashboard bell + dropdown) ──────────────────


class Notification(Base):
    """Persistent in-app notification surfaced in the admin dashboard.

    Scoped to a ``client_id`` (workspace owner) so every operator in the
    workspace sees the same feed. ``operator_id`` is reserved for future
    per-operator notifications (e.g. "you were @mentioned") and is NULL for
    the three workspace-wide types currently in use:

      * ``plan_purchased``           (billing webhook activated a paid plan
      * ``bot_created``) a new bot was created in the workspace
      * ``offline_message_received`` (visitor submitted the offline form
      * ``handoff_request``) visitor pressed "Talk to a human"
        (also drives the in-app banner; persisted so a missed handoff still
        shows up in the bell when the operator returns to the dashboard)

    ``data`` is a free-form JSON blob carrying type-specific payload (bot_id,
    plan name, message preview, session_id, etc.). ``link`` is an optional
    in-app route to navigate to on click. Both are validated in the service
    layer, not at the DB level. Schema-on-read keeps adding new types cheap.
    """

    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(
        Integer,
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    operator_id = Column(
        Integer,
        ForeignKey("operators.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    type = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    body = Column(Text, nullable=True)
    link = Column(String, nullable=True)
    data = Column(JSONB, nullable=True)
    is_read = Column(Boolean, nullable=False, server_default=sqlalchemy.text("false"))
    read_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        index=True,
    )

    __table_args__ = (
        Index("ix_notifications_client_created", "client_id", "created_at"),
        Index("ix_notifications_client_unread", "client_id", "is_read"),
    )

    client = relationship("Client", foreign_keys=[client_id])
    operator = relationship("Operator", foreign_keys=[operator_id])


class Event(Base):
    """A structured upcoming/past event or webinar extracted from a bot's
    knowledge base.

    Populated by ``ingestion.event_extractor`` when a crawled page looks like
    an events/webinars listing. The chat pipeline routes date-sensitive
    questions ("any upcoming webinars?") to a plain SQL query against this
    table instead of the RAG vector search, which eliminates the class of
    bug where the LLM would either miss upcoming events or label past dates
    as upcoming. See rag_service ``_build_date_hints`` regression history.

    ``(bot_id, source_url, title)`` is the natural identity used for
    idempotent upserts across re-crawls: the same event on the same page
    updates ``last_seen_at`` instead of creating a duplicate.
    ``last_seen_at`` doubles as the pruning signal, an event whose source
    page stopped mentioning it for more than the retention window is
    assumed removed by the customer and is deleted by
    ``task_prune_stale_events``.
    """

    __tablename__ = "events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(
        Integer,
        ForeignKey("bots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title = Column(String, nullable=False)
    # Absolute event start; timezone-aware so PAST/UPCOMING comparisons
    # against ``now(UTC)`` are unambiguous no matter which timezone the
    # customer's page or the server runs in.
    starts_at = Column(DateTime(timezone=True), nullable=False)
    ends_at = Column(DateTime(timezone=True), nullable=True)
    url = Column(String, nullable=True)
    location = Column(String, nullable=True)
    # Which crawled page this event was extracted from. Used both as part
    # of the dedup key and to give the LLM a link when answering.
    source_url = Column(String, nullable=False)
    # Optional link back to the exact Document row the extractor read; kept
    # for traceability / debugging, not required for correctness. Set to
    # NULL on delete of the source document so pruning the events survives
    # cascade-delete ordering surprises.
    source_chunk_id = Column(
        Integer,
        ForeignKey("documents.id", ondelete="SET NULL"),
        nullable=True,
    )
    extracted_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_seen_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        # Natural identity for idempotent re-crawl upserts.
        UniqueConstraint("bot_id", "source_url", "title", name="uq_events_bot_source_title"),
        # Hot-path index for the "upcoming events for this bot" query.
        Index("ix_events_bot_starts_at", "bot_id", "starts_at"),
        # Pruning sweep query.
        Index("ix_events_bot_last_seen_at", "bot_id", "last_seen_at"),
    )

    bot = relationship("Bot", back_populates="events")


class EmailSuppression(Base):
    """Permanent per-bot unsubscribe/bounce list. Scoped by ``bot_id``.
    Unsubscribing from one customer's follow-ups must never suppress that
    address for a different, unrelated customer's bot. Checked by Gate 3
    before any manual follow-up send. Once added, a row is never removed
    by application code."""

    __tablename__ = "email_suppressions"
    id = Column(Integer, primary_key=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String, nullable=False)
    reason = Column(String)  # 'hard_bounce', 'unsubscribe', 'spam_complaint'
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("bot_id", "email", name="uq_email_suppressions_bot_email"),)
