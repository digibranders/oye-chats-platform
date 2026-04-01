# Database Schema

OyeChats uses PostgreSQL 16 with the pgvector extension for vector similarity search. The ORM is SQLAlchemy 2.0, and migrations are managed by Alembic.

## Entity Relationship Overview

```
Client (1) ──→ (N) Bot (1) ──→ (N) Document
                    │
                    ├──→ (N) ChatSession (1) ──→ (N) ChatMessage
                    │         │
                    │         └──→ (0..1) LeadInfo
                    │
                    ├──→ (N) OfflineMessage
                    └──→ (N) CannedResponse

Client (1) ──→ (N) Operator
Client (1) ──→ (N) Department
```

## Models

### Client

The workspace owner / account holder. Each client can own multiple bots.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `name` | String | not null | Account display name |
| `email` | String | unique, not null | Login email |
| `hashed_password` | String | not null | bcrypt hash |
| `api_key` | String | unique | Private API key for admin auth |
| `is_superadmin` | Boolean | default: false | Platform admin flag |
| `max_bots` | Integer | default: 100 | Bot creation limit |
| `reset_otp` | String | nullable | Password reset OTP |
| `reset_otp_expires_at` | DateTime | nullable | OTP expiry |
| `created_at` | DateTime | auto | |
| `updated_at` | DateTime | auto | |

**Legacy fields** (kept for backward compatibility): `system_prompt`, `bot_logo`, `primary_color`, `header_color`, `user_bubble_color`. These have been migrated to the Bot model.

### Bot

An individual chatbot instance with its own knowledge base, settings, and appearance.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `client_id` | Integer | FK → Client.id | Owner |
| `bot_key` | String | unique, not null | Public key for widget auth (e.g., `bot-6a427d4529b9`) |
| `name` | String | not null | Bot display name |
| `website` | String | nullable | Customer's website URL |
| `system_prompt` | Text | nullable | Custom LLM system prompt |

**Appearance:**

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `bot_logo` | String | null | URL to custom logo image |
| `primary_color` | String | null | Widget accent color (hex) |
| `header_color` | String | null | Widget header background (hex) |
| `user_bubble_color` | String | null | User message bubble color (hex) |
| `avatar_type` | String | `"orb"` | Bot avatar style |

**Features:**

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `bant_enabled` | Boolean | false | Enable BANT sales qualification |
| `lead_form_enabled` | Boolean | false | Show lead capture form |
| `lead_form_fields` | JSONB | `["name","email"]` | Fields to collect |
| `live_chat_enabled` | Boolean | false | Enable operator handoff |
| `operator_timeout_seconds` | Integer | 120 | Seconds before auto-fallback to bot |
| `business_hours` | JSON | null | When operators are available |

**Notifications:**

| Column | Type | Description |
|--------|------|-------------|
| `notification_email` | String | Email for alerts |
| `email_on_qualified` | Boolean | Notify when lead qualifies (BANT) |
| `email_on_handoff` | Boolean | Notify on live chat handoff |

### Document

A chunk of ingested content stored with its vector embedding for retrieval.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `bot_id` | Integer | FK → Bot.id | Owner bot |
| `client_id` | Integer | FK → Client.id | Legacy owner (being phased out) |
| `document_name` | String | not null | Source filename or URL |
| `file_hash` | String | indexed | SHA-256 hash for deduplication |
| `content` | Text | not null | The text chunk |
| `metadata_info` | JSONB | nullable | Page numbers, section headers, source URL |
| `embedding` | Vector(1536) | pgvector | OpenAI text-embedding-3-small vector |
| `search_vector` | TSVECTOR | GIN indexed | Full-text search index |
| `created_at` | DateTime | auto | |

**Indexes:**
- `ix_document_file_hash` — fast deduplication lookups
- GIN index on `search_vector` — full-text keyword search
- IVFFlat/HNSW index on `embedding` — approximate nearest neighbor search

### ChatSession

A conversation between a visitor and the bot/operator.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | String | PK | Session identifier |
| `bot_id` | Integer | FK → Bot.id | |
| `client_id` | Integer | FK → Client.id | Legacy |
| `location` | String | nullable | Visitor geolocation |
| `device` | String | nullable | Browser + OS info |
| `visitor_metadata` | JSONB | nullable | Additional visitor data |
| `status` | String | default: `"bot"` | `bot` \| `waiting` \| `live` \| `closed` |
| `assigned_operator_id` | Integer | FK → Operator.id | For live chat |
| `department_id` | Integer | FK → Department.id | Routing target |
| `created_at` | DateTime | auto | |
| `updated_at` | DateTime | auto | |

**BANT State** (sales qualification tracking):

| Column | Type | Description |
|--------|------|-------------|
| `bant_need` | String | Identified need |
| `bant_timeline` | String | Purchase timeline |
| `bant_authority` | String | Decision-making authority |
| `bant_budget` | String | Budget information |

### ChatMessage

An individual message within a chat session.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `session_id` | String | FK → ChatSession.id | |
| `role` | String | not null | `user` \| `bot` \| `operator` \| `system` |
| `content` | Text | not null | Message text |
| `feedback` | Integer | nullable | `-1` (down), `0` (neutral), `1` (up) |
| `trace_id` | String | nullable | Langfuse trace ID for LLM debugging |
| `created_at` | DateTime | auto | |

### LeadInfo

Contact information captured from the widget lead form.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `session_id` | String | unique FK → ChatSession.id | One lead per session |
| `bot_id` | Integer | FK → Bot.id | |
| `name` | String | nullable | |
| `email` | String | nullable | |
| `phone` | String | nullable | |
| `company` | String | nullable | |
| `created_at` | DateTime | auto | |

### Operator

A live chat team member who can take over conversations from the bot.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `client_id` | Integer | FK → Client.id | |
| `name` | String | not null | |
| `email` | String | unique, not null | |
| `hashed_password` | String | not null | bcrypt hash |
| `operator_api_key` | String | unique | Auth key |
| `role` | String | default: `"operator"` | `owner` \| `admin` \| `operator` |
| `is_online` | Boolean | default: false | Availability status |
| `avatar_url` | String | nullable | Profile image |
| `max_concurrent_chats` | Integer | default: 5 | Workload cap |
| `notification_preferences` | JSONB | nullable | Alert settings |
| `department_id` | Integer | FK → Department.id | |
| `created_at` | DateTime | auto | |

### Department

Organizational grouping for operators and chat routing.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK, auto-increment | |
| `client_id` | Integer | FK → Client.id | |
| `name` | String | not null | |
| `description` | String | nullable | |

### OfflineMessage

Messages left by visitors when no operators are available.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK | |
| `bot_id` | Integer | FK → Bot.id | |
| `session_id` | String | FK → ChatSession.id | |
| `name` | String | | Visitor name |
| `email` | String | | Visitor email |
| `message` | Text | | Message content |
| `is_read` | Boolean | default: false | |
| `is_replied` | Boolean | default: false | |
| `created_at` | DateTime | auto | |

### CannedResponse

Pre-saved reply templates for operator efficiency.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | Integer | PK | |
| `client_id` | Integer | FK → Client.id | |
| `title` | String | not null | Quick reference name |
| `content` | Text | not null | Reply text |
| `created_at` | DateTime | auto | |

## Migrations

Migrations are managed with Alembic. Migration files live in `api/alembic/versions/`.

```bash
# Create a new migration after model changes
uv run alembic revision --autogenerate -m "add lead_form_fields to bot"

# Apply all pending migrations
uv run alembic upgrade head

# Rollback one step
uv run alembic downgrade -1

# View current migration state
uv run alembic current
```

Always run migrations on the `development` database first and verify before applying to production.
