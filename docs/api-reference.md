# API Reference

Base URL: `https://api.oyechats.com` (production) / `http://localhost:8000` (development)

## Authentication

All API requests require one of two authentication headers:

| Header | Purpose | Example |
|--------|---------|---------|
| `X-Bot-Key` | Widget (visitor-facing) endpoints | `bot-6a427d4529b9` |
| `X-API-Key` | Admin/operator endpoints | Client or Operator API key |

The `X-Bot-Key` is a public key embedded in the widget script tag. The `X-API-Key` is a private key assigned to each client account or operator.

## Rate Limits

- Chat endpoints: **30 requests/minute** per bot key
- Other endpoints: Per-endpoint limits via `@limiter.limit()`

Rate limit responses return `429 Too Many Requests`.

---

## Auth Routes (`/auth`)

### POST /auth/register

Create a new client account.

**Request Body:**
```json
{
  "name": "string",
  "email": "string",
  "password": "string"
}
```

**Response:** `201 Created`
```json
{
  "id": 1,
  "name": "Acme Corp",
  "email": "admin@acme.com",
  "api_key": "ck_abc123..."
}
```

### POST /auth/login

Authenticate and receive an API key.

**Request Body:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response:** `200 OK`
```json
{
  "id": 1,
  "name": "Acme Corp",
  "email": "admin@acme.com",
  "api_key": "ck_abc123..."
}
```

### POST /auth/request-password-reset

Request a password reset OTP sent via email.

**Request Body:**
```json
{
  "email": "string"
}
```

**Response:** `200 OK`

### POST /auth/reset-password

Reset password using OTP.

**Request Body:**
```json
{
  "email": "string",
  "otp": "string",
  "new_password": "string"
}
```

**Response:** `200 OK`

---

## Bot Routes (`/bots`)

### GET /bots/settings/public

Fetch bot settings for the widget. **Auth: `X-Bot-Key`**

**Response:** `200 OK`
```json
{
  "name": "Support Bot",
  "system_prompt": "You are a helpful assistant...",
  "bot_logo": "https://...",
  "primary_color": "#6366F1",
  "header_color": "#1E1B4B",
  "user_bubble_color": "#6366F1",
  "avatar_type": "orb",
  "lead_form_enabled": true,
  "lead_form_fields": ["name", "email", "phone"],
  "live_chat_enabled": false,
  "bant_enabled": false,
  "business_hours": {...}
}
```

### GET /bots

List all bots for the authenticated client. **Auth: `X-API-Key`**

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "bot_key": "bot-6a427d4529b9",
    "name": "Support Bot",
    "website": "https://acme.com",
    "created_at": "2025-01-15T10:30:00Z"
  }
]
```

### POST /bots

Create a new bot. **Auth: `X-API-Key`**

**Request Body:**
```json
{
  "name": "string",
  "website": "string (optional)",
  "system_prompt": "string (optional)"
}
```

**Response:** `201 Created` — returns the new bot object with its `bot_key`.

### GET /bots/{id}

Get a specific bot's full details. **Auth: `X-API-Key`**

### PATCH /bots/{id}

Update bot settings (name, colors, system prompt, feature flags, etc.). **Auth: `X-API-Key`**

**Request Body:** Any subset of bot fields:
```json
{
  "name": "Updated Bot",
  "primary_color": "#10B981",
  "bant_enabled": true,
  "lead_form_enabled": true,
  "lead_form_fields": ["name", "email"],
  "notification_email": "alerts@acme.com"
}
```

### DELETE /bots/{id}

Delete a bot and all associated data. **Auth: `X-API-Key`**

---

## Chat Routes (`/chat`)

### POST /chat

Send a message and get a synchronous response. **Auth: `X-Bot-Key`**

**Request Body:**
```json
{
  "message": "What are your pricing plans?",
  "session_id": "string (optional — auto-generated if omitted)"
}
```

**Response:** `200 OK`
```json
{
  "response": "We offer three pricing tiers...",
  "session_id": "sess_abc123",
  "sources": ["pricing-guide.pdf"],
  "message_id": 456
}
```

### POST /chat/stream

Send a message and receive a streaming SSE response. **Auth: `X-Bot-Key`**

**Request Body:** Same as `/chat`.

**Response:** `text/event-stream`

The SSE stream uses a custom protocol:
```
METADATA:{"sources": ["doc.pdf"], "session_id": "sess_abc123"}
First chunk of text...
More text arrives...
FINAL_METADATA:{"message_id": 456, "trace_id": "tr_xyz"}
```

Lines prefixed with `METADATA:` contain JSON with initial context (sources, session ID). Lines prefixed with `FINAL_METADATA:` contain the message ID and Langfuse trace ID. All other lines are response text chunks.

### POST /chat/lead-capture

Submit a lead capture form from the widget. **Auth: `X-Bot-Key`**

**Request Body:**
```json
{
  "session_id": "sess_abc123",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+1234567890",
  "company": "Acme Inc"
}
```

### POST /chat/feedback/{message_id}

Submit feedback on a bot response. **Auth: `X-Bot-Key`**

**Request Body:**
```json
{
  "feedback": 1
}
```

Values: `1` (thumbs up), `-1` (thumbs down), `0` (neutral/reset).

### GET /chat/history/{session_id}

Retrieve all messages in a chat session. **Auth: `X-Bot-Key`**

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "role": "user",
    "content": "What do you offer?",
    "created_at": "2025-01-15T10:30:00Z"
  },
  {
    "id": 2,
    "role": "bot",
    "content": "We offer...",
    "feedback": 1,
    "trace_id": "tr_xyz",
    "created_at": "2025-01-15T10:30:02Z"
  }
]
```

---

## Document Routes (`/documents`)

### GET /documents

List all documents for a bot. **Auth: `X-API-Key`**

**Query Parameters:**
- `bot_id` (required) — the bot to list documents for

### DELETE /documents/{name}

Delete a document and all its chunks/embeddings. **Auth: `X-API-Key`**

### POST /upload

Upload a document (PDF, DOCX, or TXT) for ingestion. **Auth: `X-API-Key`**

**Request:** `multipart/form-data`
- `file` — the document file
- `bot_id` — target bot ID

The document goes through the full ingestion pipeline: extraction → cleaning → chunking → embedding → storage.

### POST /crawl

Crawl a website and ingest its content. **Auth: `X-API-Key`**

**Request Body:**
```json
{
  "url": "https://acme.com/docs",
  "bot_id": 1
}
```

Crawls up to 50 pages, max depth 3, with 5 concurrent requests. Each page is processed through the ingestion pipeline.

---

## Analytics Routes (`/analytics`)

All analytics endpoints require **Auth: `X-API-Key`**.

### GET /analytics/dashboard

Summary statistics for the authenticated client.

### GET /analytics/activity

Chat activity over time (for charting).

### GET /analytics/top-questions

Most frequently asked questions across bots.

### GET /analytics/visitors

Visitor metadata (device, location, session counts).

### GET /analytics/feedback

Feedback summary (thumbs up/down distribution).

---

## Operator Routes (`/operators`)

### GET /operators

List all operators. **Auth: `X-API-Key` (owner/admin only)**

### POST /operators

Create an operator account. **Auth: `X-API-Key` (owner/admin only)**

**Request Body:**
```json
{
  "name": "string",
  "email": "string",
  "password": "string",
  "role": "operator",
  "department_id": 1
}
```

Roles: `owner`, `admin`, `operator`.

### PATCH /operators/{id}

Update an operator's details, status, or role. **Auth: `X-API-Key`**

### DELETE /operators/{id}

Remove an operator. **Auth: `X-API-Key` (owner/admin only)**

### POST /operators/handoff

Request a live chat handoff from bot to human operator. **Auth: `X-Bot-Key`**

### GET /operators/departments/public

List departments available for handoff (public, no auth required for widget).

### Department CRUD

- `POST /operators/departments` — Create department
- `PATCH /operators/departments/{id}` — Update department
- `DELETE /operators/departments/{id}` — Delete department

---

## Client Routes (`/client`)

### GET /client/settings

Get the authenticated client's account settings. **Auth: `X-API-Key`**

### PATCH /client/settings

Update account settings. **Auth: `X-API-Key`**

### POST /client/api-key

Regenerate the client's API key. **Auth: `X-API-Key`**

---

## Lead Routes (`/leads`)

### GET /leads

List all captured leads. **Auth: `X-API-Key`**

### GET /leads/{id}

Get a specific lead's details. **Auth: `X-API-Key`**

### PUT /leads/{id}

Update lead qualification status. **Auth: `X-API-Key`**

---

## Offline Message Routes (`/offline-messages`)

### POST /offline-messages

Submit an offline message when no operators are available. **Auth: `X-Bot-Key`**

### GET /offline-messages

List all offline messages. **Auth: `X-API-Key`**

### PATCH /offline-messages/{id}

Mark an offline message as read or replied. **Auth: `X-API-Key`**

---

## Canned Response Routes (`/canned-responses`)

Standard CRUD for pre-saved operator reply templates. **Auth: `X-API-Key`**

- `GET /canned-responses` — List all
- `POST /canned-responses` — Create
- `PATCH /canned-responses/{id}` — Update
- `DELETE /canned-responses/{id}` — Delete

---

## Billing and Pricing Routes

Every price OyeChats publishes is a **base price, exclusive of GST**. `Plan.monthly_price_cents`,
the add-on price env vars and the top-up pack amounts are all bases. For an Indian customer the tax
is added at charge time, so the amount actually debited is base + GST. For an international
customer the sale is an export of services, no Indian GST applies, and the listed USD price is the
full charge.

Endpoints that quote money therefore return the base **and** the gross. A UI that shows a customer
one number before the payment sheet opens must show the gross; quoting the base as the amount
payable understates it by the tax.

`tax_rate_bps` is the rate that will be added to this caller's charges, in basis points (`1800` =
18%). Zero is a real answer, not a placeholder: an export pays no Indian GST, and a seller with no
GSTIN configured adds none.

### GET /subscriptions/checkout/quote

Single source of truth for what the checkout button will charge. **Auth: `X-API-Key`**

Query: `plan_id` (required), `billing_cycle` (`monthly` | `annual`, default `monthly`),
`billing_country` (optional override).

| Field | Description |
|-------|-------------|
| `amount_minor` | The advertised BASE, in minor units (paise for INR, cents for USD) |
| `amount_display` | Formatted base |
| `tax_minor` | Tax added at charge time. `0` on the USD rail |
| `tax_rate_bps` | Rate applied. `0` on the USD rail |
| `gross_minor` | What the mandate actually debits |
| `gross_display` | Formatted gross, e.g. `"₹1,414.82"` |

All four tax fields are present on every branch of the response, including free plans and
`checkout_supported: false`, so no caller has to handle a quote with the tax missing.

### GET /subscriptions/geo

Billing country, rail and gateway availability for the current account. **Auth: `X-API-Key`**

Adds `tax_rate_bps`: the rate that will be added to this account's charges. It is `0` whenever
`display_currency` is `USD`, so the rate can never drift from the currency it applies to.

### POST /subscriptions/seats

Change the extra-operator-seat count. **Auth: `X-API-Key`**

| Field | Description |
|-------|-------------|
| `extra_seat_price_cents` | Seat BASE price per seat per month |
| `gross_extra_seat_price_cents` | What the seat add-on mandate collects per seat |
| `tax_rate_bps` | Rate applied |

Both the pending-authorization and the applied response carry these fields.

### POST /subscriptions/branding-addon · DELETE /subscriptions/branding-addon

Purchase or cancel branding removal. **Auth: `X-API-Key`**

Both routes, and the already-active and not-active short circuits, return the same shape:

| Field | Description |
|-------|-------------|
| `price_cents` | Add-on BASE price |
| `gross_price_cents` | What the add-on mandate collects |
| `tax_rate_bps` | Rate applied |

### GET /credits/packs

Public list of currently-offered credit top-up packs. **No auth.**

Each pack gains:

| Field | Description |
|-------|-------------|
| `gross_inr` | What the top-up order collects, in rupees (the pack's `inr` is the base) |
| `tax_rate_bps` | Rate applied |

There is no auth here, so the buyer's rail is unknown and the domestic rate is quoted. The
authenticated top-up flow charges per the buyer's own supply kind.

### GET /public/pricing-catalog

Public plan catalog used by the marketing site. **No auth.**

| Field | Description |
|-------|-------------|
| `prices_exclude_tax` | Always `true`. Every price in the payload is a base price |
| `tax_rate_bps` | The rate Indian customers are charged on top |

The marketing site renders its tax disclosure from this rate rather than hardcoding a second 18%
that can silently disagree with the charge path.

### GET /subscriptions/admin/plan-price-check

Diagnostic: local plan price against the live Razorpay plan amount. **Auth: `X-API-Key`, superadmin
only.** Never 500s; a Razorpay error on any row yields `in_sync: null` plus an error string.

Each row compares Razorpay's amount against `expected_charge_minor`, which is the **gross**, not the
base. Checking the base would report every correctly minted INR plan as drifted, and would pass a
plan still billing the old GST-inclusive amount.

- `plans[]` covers all four cycles per plan: `monthly`, `annual`, `monthly_usd`, `annual_usd`.
- `addons[]` covers `operator_seat` and `branding_removal`, each with an `inr` and a `usd` entry.
  An unconfigured plan id reports `error: "not configured"`.
- `tax_rate_bps` at the top level is the rate used to compute every expected gross.

---

## WebSocket Routes (`/ws`)

Real-time messaging for live chat sessions between operators and visitors.

**Connection:** `ws://localhost:8000/ws/{session_id}?token={api_key}`

Messages are JSON-encoded with `role`, `content`, and `session_id` fields.

---

## Superadmin Routes (`/superadmin`)

Admin-only endpoints for workspace management. Requires superadmin privileges.

---

## Error Responses

All errors follow a consistent format:

```json
{
  "detail": "Description of the error"
}
```

| Status Code | Meaning |
|-------------|---------|
| 400 | Bad Request — invalid input or business rule violation |
| 401 | Unauthorized — missing or invalid API key / bot key |
| 403 | Forbidden — insufficient permissions |
| 404 | Not Found — resource does not exist |
| 422 | Validation Error — request body failed Pydantic validation |
| 429 | Too Many Requests — rate limit exceeded |
| 504 | Gateway Timeout — request exceeded 60-second timeout |
