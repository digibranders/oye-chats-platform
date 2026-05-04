# Brevo template upload guide

These six `*.brevo.html` files are paste-ready for the Brevo dashboard. Each one
uses `{{ params.x }}` placeholders that the backend (`api/app/services/email_service.py`)
already supplies at send time.

## How to upload

1. Sign in to Brevo &rarr; **Templates** &rarr; **Email Templates**
   (https://app.brevo.com/templates/listing).
2. For each row in the table below, open the existing template by ID, click
   **Edit design** &rarr; **Code** (HTML editor), select all, and paste the
   matching `*.brevo.html` file's contents.
3. **Save**. Use **Send a test** to send to `admin@digibranders.com` and
   spot-check the rendering.

## Template map

| ID | File | Purpose | Params used |
|----|------|---------|-------------|
| 57 | `01_password_reset.brevo.html` | Password reset OTP | `otp` |
| 60 | `02_qualified_lead.brevo.html` | Lead reaches BANT/MEDDIC tier | `bot_name`, `tier`, `tier_label`, `badge_bg`, `badge_color`, `accent_color`, `accent_bg`, `accent_border`, `bant_need`, `bant_budget`, `bant_authority`, `bant_timeline`, `contact_name`, `contact_email`, `contact_phone`, `contact_company` |
| 61 | `03_handoff_request.brevo.html` | Visitor requests live agent | `bot_name`, `contact_name`, `contact_email`, `reason` |
| 62 | `04_missed_callback.brevo.html` | Offline message + no agent | `bot_name`, `contact_name`, `contact_email`, `contact_phone` |
| 58 | `05_offline_message.brevo.html` | Offline message form submit | `bot_name`, `visitor_name`, `visitor_email`, `message_preview` |
| 59 | `07_visitor_confirmation.brevo.html` | Visitor self-confirmation | `bot_name`, `visitor_name`, `visitor_email` |

## Why no Brevo flavor for the chat transcript (06)?

`send_transcript_email` builds raw HTML at runtime via `_base_template` and sends
it through `_send_brevo_email` (not `_send_brevo_template`). Template #63 in
Brevo is a visual reference only and is not used for delivery. The
`06_chat_transcript.html` file in this directory is the visual canon for that
runtime path — re-run `scripts/render_email_previews.py` to refresh it whenever
the helpers change.

## Regenerating these files

```bash
cd platform/api
uv run python scripts/render_email_previews.py
```

Outputs both flavors plus `preview/index.html` for visual QA.
