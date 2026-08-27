# OyeChats — Complete Email Inventory

> Audit of every transactional/lifecycle email the platform sends.
> Source of truth: `api/app/services/email_service.py` + all call-sites across `api/app`.
> Provider: **Brevo (Sendinblue)** transactional API — `https://api.brevo.com/v3/smtp/email`.
>
> **Kept accurate automatically.** `tests/test_email_inventory_accuracy.py` fails CI if
> this doc drifts from the real `send_*` functions in `email_service.py` — a new email
> that isn't documented here, a documented email that was removed, or a wrong headline
> count all break the build. So this file cannot silently go stale: update it whenever
> you add, rename, or remove an email sender.

---

## 1. Sending Infrastructure

| Item | Value |
|------|-------|
| Provider | Brevo (Sendinblue) transactional API |
| Service module | `api/app/services/email_service.py` |
| Master on/off switch | `EMAIL_ENABLED` = `bool(BREVO_API_KEY)` — no key ⇒ **all sends silently skipped (logged as WARN)** |
| From name | `EMAIL_FROM_NAME` (default `OyeChats`) |
| From address | `EMAIL_FROM_ADDRESS` (default `notifications@oyechats.com`) — no-reply sender |
| Support address (shown in body / "Contact us") | `SUPPORT_EMAIL` (default `developer@oyechats.com`) |
| Marketing links | `MARKETING_URL` (default `https://www.oyechats.com`) |
| Dashboard links | `APP_URL` (default `https://app.oyechats.com`) |
| Invoice-email gate | `INVOICE_EMAILS_ENABLED` (default `true`) |

### Rendering — all in code (one design system)
**Every email now renders raw HTML in Python** from the shared design system in
`app/services/email_design.py` (monochrome + single-indigo-accent, dark-mode hardened
for Outlook). There are **no Brevo saved templates in the send path** — all 20 senders
build HTML and dispatch through `_send_brevo_email()` (which supports attachments, used
by invoices). The gallery in `emails/gallery/` is generated from these same senders, so
what you review is what customers receive.

The legacy `_send_brevo_template()` transport and the `TEMPLATE_*` IDs (57–63) still
exist for backward-compat and the super-admin catalogue, but nothing sends through them.

### Delivery model (`send_email_async`)
- Fire-and-forget, non-blocking.
- If `WORKER_ENABLED=true` → enqueued to **ARQ** (durable, retryable) via `task_send_email`.
- Otherwise → thread-pool / daemon-thread fallback.
- Failures captured to **Sentry** with `email.*` tags (`_capture_email_failure`); Brevo error body is parsed for the real reason (`_extract_brevo_error`).

### Credit metering — none
**No email deducts credits.** A `meter_customer_email()` helper used to exist as an unwired stub (never called from any send site); it was removed as dead code, and the super-admin template registry now reports `metered: false` for every template. The `credit_cost.email_send` pricing key and its usage-reporting surface remain in place (they read 0), so per-email metering can be wired up later if the product decides to charge for sends.

---

## 2. Email Catalogue (29 distinct emails)

Grouped by category. All emails render raw HTML in code (see above). Any `#NN` is the legacy Brevo template ID for reference only — it is **not** used to send.

### A. Authentication & Account (raw HTML unless noted — always free)

#### A1. Email verification OTP
| | |
|---|---|
| Function | `send_verification_otp_email(to_email, name, otp)` |
| Rendering | Raw HTML (blue header, 6-digit monospace code) |
| Subject | `Your OyeChats verification code` |
| Audience | New customer (client) |
| Body | "Verify your email" — 6-digit code, **expires in 15 min** |
| Triggers | `auth_routes.py:619` resend-verification endpoint; `auth_routes.py:813` on register (new client) |
| Metered | No |

#### A2. Password reset OTP
| | |
|---|---|
| Function | `send_password_reset_email(to_email, otp)` |
| Rendering | Raw HTML (Linear-style code box) — legacy Brevo ID #57 unused |
| Audience | Customer |
| Params | `{otp}` |
| Triggers | `auth_routes.py:860` — `POST /auth/forgot-password`; `superadmin_routes_v2.py:369` — super-admin triggers reset for a target user |
| Metered | No |

#### A3. Confirm new email (email change) OTP
| | |
|---|---|
| Function | `send_email_change_otp(to_email, name, otp)` |
| Rendering | Raw HTML (6-digit code) |
| Subject | `Confirm your new OyeChats email address` |
| Audience | Client's **new** email address |
| Body | Code to confirm email change, **expires in 15 min** |
| Trigger | `client_routes.py:414` — client requests email change |
| Metered | No |

#### A4. Email-change security notice
| | |
|---|---|
| Function | `send_email_change_requested_notice(to_email, name, new_email)` |
| Rendering | Raw HTML (dark header — security tripwire) |
| Subject | `Email change requested on your OyeChats account` |
| Audience | Client's **current/old** email address |
| Body | "Someone requested to change your login email to `{new_email}`" + reset-password warning |
| Trigger | `client_routes.py:415` — sent alongside A3 on email-change request |
| Metered | No |

### B. Trial Lifecycle (raw HTML — free; best-effort, swallow transport errors)

#### B1. Trial welcome (Day 0)
| | |
|---|---|
| Function | `send_trial_welcome_email(to_email, name, trial_end, credits, duration_days)` |
| Subject | `Welcome to OyeChats — your {N}-day trial is live` |
| Body | Confirms trial active + exact end date, credit allowance, dashboard CTA, 3-step quick-start |
| Triggers | `auth_routes.py:769` (register); `oauth_routes.py:392` (OAuth signup); `subscription_routes.py:221` (trial start) |
| Metered | No |

#### B2. Trial midpoint check-in (T-4 on the 7-day trial)
| | |
|---|---|
| Function | `send_trial_halfway_email(to_email, name, days_remaining, plan_name)` |
| Subject | `You're halfway through your OyeChats trial` |
| Trigger | ARQ cron `task_trial_reminder_emails` (`tasks.py:879`) — **daily 09:00** — fires when `days_remaining == 4` (marker key `day_7` preserved from the legacy 14-day cadence) |
| Metered | No |

#### B3. Trial "X days left" (T-2 warning and final-day alarm)
| | |
|---|---|
| Function | `send_trial_days_left_email(to_email, name, days_remaining, plan_name)` |
| Subject | `{N} days left in your OyeChats trial` / `Your OyeChats trial ends tomorrow` (≤1 day) |
| Trigger | ARQ cron `task_trial_reminder_emails` (`tasks.py:886`) — **daily 09:00** — fires when `days_remaining ∈ {2, 1}` (marker keys `day_11`, `day_13` preserved from the legacy 14-day cadence) |
| Metered | No |

#### B4. Trial ended
| | |
|---|---|
| Function | `send_trial_ended_email(to_email, name, plan_name, data_retention_until)` |
| Subject | `Your OyeChats trial has ended — pick a plan to keep your bot live` |
| Body | Bot now offline; **15-day data retention** window quoted; reactivate CTA |
| Trigger | ARQ cron `task_expire_trials` (`tasks.py:765`) — **hourly at minute :15** |
| Metered | No |

#### B5. Trial data deleted
| | |
|---|---|
| Function | `send_trial_data_deleted_email(to_email, name)` |
| Subject | `Your OyeChats workspace has been deleted` |
| Body | Confirms permanent purge of bots/documents/chat history; no CTA |
| Trigger | ARQ cron `task_delete_expired_trial_data` (`tasks.py:952`) — **daily 00:20** |
| Metered | No |

### C. Billing

#### C1. Invoice / receipt / credit note (with PDF attachment)
| | |
|---|---|
| Function | `send_invoice_email(to_email, invoice, pdf_url, pdf_bytes)` |
| Rendering | Raw HTML + **PDF attachment** (base64); download link as fallback |
| Subject | `{Tax invoice\|Credit note\|Receipt} {invoice_number} from {seller}` |
| Body | Doc no., amount (INR, Indian grouping), GST included/reversed, download CTA |
| Gate | Only sends when `INVOICE_EMAILS_ENABLED` (shadow mode never emails) |
| Triggers | ARQ cron `task_render_invoice_pdfs` (`tasks.py:1448` & `:1480`) — **every 5 min at :01,:06,…**; super-admin manual resend `superadmin_routes_v2.py:1654` |
| Metered | No |

#### C2. Downgrade re-authorization (UPI mandate)
| | |
|---|---|
| Function | `send_downgrade_reauth_email(to_email, name, old_plan_name, new_plan_name, reauth_url)` |
| Subject | `Action needed: confirm your switch to {new_plan}` |
| Body | UPI mandate can't be updated → authorize new lower-plan mandate; account paused until confirmed |
| Trigger | `transition_service.py:342` (scheduled-downgrade cutover, driven by cron `task_promote_scheduled_downgrades` — **daily 00:07**) |
| Metered | No |
| Context | See Razorpay UPI update constraint — plan change = cancel + recreate + re-auth |

#### C3. Operator-seat re-authorization (UPI mandate)
| | |
|---|---|
| Function | `send_seat_reauth_email(to_email, name, seat_count, reauth_url)` |
| Subject | `Action needed: re-authorize your operator seats` |
| Body | Plan cutover moved the seat add-on to a new UPI mandate → authorize it so carried seats aren't suspended |
| Trigger | `razorpay_service.py` seat carry inside `_handle_subscription_activated` (a plan cutover carrying operator seats onto the new subscription) |
| Metered | No |
| Context | Seats bill on a SEPARATE mandate (P0-3); a cutover mints a new, uncharged seat sub that must be re-authorized (finding A follow-up) |

#### C4. Payment failed — day 0 (dunning)
| | |
|---|---|
| Function | `send_payment_failed_email(to_email, name, plan_name, amount)` |
| Subject | `We couldn't process your payment — we'll retry` |
| Body | The charge was declined; we retry automatically. Asks for NOTHING and carries no link |
| Trigger | `task_dunning_emails` cron, day 0 of `past_due` (marker `failed_0`) |
| Metered | No |
| Context | Razorpay is still auto-retrying (`pending`, ~daily for T+3), so most of these self-resolve. Alarming the customer here creates support load for a problem that usually fixes itself; skipping the recovery link also spares one gateway call per past-due customer per pass |

#### C5. Payment action required — day 3 (dunning)
| | |
|---|---|
| Function | `send_payment_action_required_email(to_email, name, plan_name, amount, recovery_url, days_left)` |
| Subject | `Action needed: update your payment method` |
| Body | Retries exhausted; agents keep working for N more days. Links to Razorpay's hosted recovery page |
| Trigger | `task_dunning_emails` cron, day 3 of `past_due` (marker `halted_3`) |
| Metered | No |
| Context | `recovery_url` is the EXISTING subscription's `short_url` — a halted sub recovers in place via Razorpay's hosted page and must never be re-minted (that would double-charge). See `dunning_service.get_recovery_link` |

#### C6. Payment final warning — day 5 (dunning)
| | |
|---|---|
| Function | `send_payment_final_warning_email(to_email, name, plan_name, recovery_url, days_left)` |
| Subject | `Your AI agents stop <today / in N days>` |
| Body | The deadline is the message: agents stop responding and the widget goes offline |
| Trigger | `task_dunning_emails` cron, day 5 of `past_due` (marker `warning_5`) |
| Metered | No |
| Context | Day count is floored by `_stop_phrase` so it can never render "in 0 days". The cadence catches up to the newest unsent bucket, so a missed tick still delivers this rather than dropping it |

#### C7. Subscription suspended (dunning end-of-life)
| | |
|---|---|
| Function | `send_subscription_suspended_email(to_email, name, plan_name, recovery_url)` |
| Subject | `Your OyeChats subscription has been suspended` |
| Body | Grace elapsed and agents are offline; data is safe; still recoverable |
| Trigger | `task_expire_past_due_subscriptions` cron on the flip to `expired` (marker `suspended`) |
| Metered | No |
| Context | `recovery_url` is optional — the gateway may be unreachable or the mandate terminal, in which case it falls back to prose rather than rendering a dead button |

#### C8. Launch-promo pre-charge reminder
| | |
|---|---|
| Function | `send_promo_precharge_reminder_email(to_email, name, plan_name, charge_date, amount_display)` |
| Subject | `Your free months are almost up` |
| Body | Heads-up that the launch-offer free period is ending and the first real charge lands on `charge_date`; cancel-before or update-card path |
| Trigger | `task_promo_precharge_reminders` cron — **daily 09:15** — ~10 days before `promo_free_until` (marker `pre_charge`) |
| Metered | No |
| Context | Fires once per promo subscription; `amount_display` is the plan's monthly price that resumes after the free window |

### D. Lead / Qualification / Live Chat

#### D1. Qualified lead alert
| | |
|---|---|
| Function | `send_qualified_lead_email(notification_email, bot_name, bant, contact, tier, reply_to)` |
| Rendering | Raw HTML (tier chip: SQL=green, MQL=amber) — legacy Brevo ID #60 unused |
| Audience | Customer (bot's `notification_emails`) |
| Params | bot_name, tier/tier_label, BANT (need/budget/authority/timeline), contact (name/email/phone/company), accent palette |
| Sender | `"{BotName} via OyeChats"`, optional `reply_to` = bot's `reply_to_email` |
| Trigger | `rag_service.py:2570` — BANT/MEDDIC **tier transition** after chat stream closes (background) |
| Metered | No |

#### D2. Handoff request
| | |
|---|---|
| Function | `send_handoff_request_email(notification_email, bot_name, reason, contact, reply_to)` |
| Audience | Operator(s) / bot handoff notification recipients |
| Body | Visitor waiting for live agent — contact + reason |
| Triggers | ARQ `task_send_visitor_message_email` (`tasks.py:1294`), enqueued from `ws_routes.py:344` when a visitor messages in a still-`waiting` (unaccepted) session and the per-process debounce allows it. **This template is reused as the "visitor sent a message while waiting" notification.** |
| Metered | No |

#### D3. Missed callback
| | |
|---|---|
| Function | `send_unavailable_callback_email(notification_email, bot_name, contact, reply_to)` |
| Audience | Customer/operator |
| Body | No agent available; visitor left contact details for callback |
| Triggers | `offline_message_routes.py:101`; `ws_routes.py:480` (queue timeout / no operator) |
| Metered | No |

#### D4. Offline message
| | |
|---|---|
| Function | `send_offline_message_email(notification_email, bot_name, visitor_name, visitor_email, message_preview, reply_to)` |
| Audience | Customer |
| Body | Visitor's offline contact-form submission |
| Triggers | `offline_message_routes.py:112` (`POST /offline-messages`); `ws_routes.py:487` |
| Metered | No |

#### D5. Visitor confirmation
| | |
|---|---|
| Function | `send_visitor_confirmation_email(to_email, company_name, visitor_name, reply_to)` |
| Rendering | Raw HTML (visitor footer) |
| Subject | `Thank you for contacting {company_name}` |
| Audience | **Visitor** (auto-reply) |
| Body | "We've received your message, our team has been notified" |
| Trigger | `offline_message_routes.py:123` — after visitor submits offline/handoff form |
| Metered | No |

#### D6. Chat transcript — (references template #63, sends raw HTML)
| | |
|---|---|
| Function | `send_transcript_email(to_email, bot_name, messages, reply_to)` |
| Rendering | **Raw HTML** (dynamic chat bubbles per role: you/bot/operator/system) |
| Subject | `Chat Transcript — {bot_name}` |
| Audience | **Visitor** |
| Body | Full formatted conversation transcript |
| Trigger | `chat_routes.py:1039` — visitor opt-in / requests transcript at session close |
| Metered | No |

#### D7. Quotation — visitor acknowledgement
| | |
|---|---|
| Function | `send_quotation_visitor_email(to_email, company_name, visitor_name, service_names, reply_to)` |
| Rendering | Raw HTML (visitor footer) |
| Subject | `Your quote request with {company_name}` |
| Audience | **Visitor** (auto-reply) |
| Body | "We've received your request for a quote on {services}" — **no pricing**. Sent **immediately** at accept; the priced document (D9) follows ~10 min later |
| Trigger | `quotation_routes.py` — `POST /chat/quotation/accept` (visitor completes the quote flow) |
| Metered | No |

#### D8. Quotation — client notification
| | |
|---|---|
| Function | `send_quotation_client_email(notification_email, bot_name, contact, currency, line_items, total, reply_to)` |
| Rendering | Raw HTML (itemised quote table + contact) |
| Subject | `New quote request from {bot_name}` |
| Audience | **Client** (bot's configured notification recipients) |
| Body | Itemised line items (name × qty → subtotal) + total + visitor contact; `reply_to` is the visitor's email |
| Trigger | `quotation_routes.py` — `POST /chat/quotation/accept` (visitor completes the quote flow) |
| Metered | No |

#### D9. Quotation — visitor document (priced PDF)
| | |
|---|---|
| Function | `send_quotation_document_email(to_email, company_name, visitor_name, currency, line_items, total, pdf_bytes, reply_to)` |
| Rendering | Raw HTML (itemised priced table, visitor footer). Delivered inline in the email body — no attachment |
| Subject | `Your quotation from {company_name}` |
| Audience | **Visitor** (auto-reply) |
| Body | The finalised quote **with pricing**: each requirement grouped under its service (label × qty unit → subtotal) + total, rendered inline |
| Trigger | `quotation_routes.py` — deferred `QUOTATION_EMAIL_DELAY_SECONDS` (~10 min) after `POST /chat/quotation/accept`, via ARQ `task_send_quotation_visitor_email` |
| Metered | No |

### E. Affiliate / Partners (raw HTML — free)

#### E1. Affiliate welcome
| | |
|---|---|
| Function | `send_affiliate_welcome_email(to_email, name)` |
| Subject | `You're now an OyeChats affiliate` |
| Audience | Existing customer enrolled as affiliate |
| Body | Enrolled in affiliate program; open `/affiliate` dashboard CTA |
| Triggers | `affiliate_routes.py:731`, `:846`, `:904` — super-admin invite where email already has a `clients` row / enroll |
| Metered | No |

#### E2. Affiliate / Partners invite (magic link)
| | |
|---|---|
| Function | `send_affiliate_invite_email(to_email, accept_url, expires_in_days=14)` |
| Subject | `You're invited to OyeChats Partners` |
| Audience | Non-customer prospect |
| Body | Magic-link invite to Partners program; **link expires in 14 days** |
| Trigger | `affiliate_routes.py:745` — super-admin invites a non-customer |
| Metered | No |

### F. Team / Live-chat operators (raw HTML — free)

#### F1. Operator workspace invite (magic link)
| | |
|---|---|
| Function | `send_operator_invite_email(to_email, accept_url, workspace_name, inviter_name, expires_in_days=7)` |
| Subject | `You've been invited to join {workspace_name} on OyeChats` |
| Audience | Prospective operator invited into a workspace by its owner/admin |
| Body | Magic-link invite; recipient accepts and lands in the workspace as an operator; **link expires in 7 days** |
| Trigger | `invite_routes.py` — workspace owner/admin creates or resends an operator invite |
| Metered | No |

---

## 3. Cron-Triggered Emails (schedule reference)

From `api/app/worker/settings.py` (`cron_jobs`) — server timezone:

| Cron task | Schedule | Emails it can send |
|-----------|----------|--------------------|
| `task_trial_reminder_emails` | daily **09:00** | B2 (T-4 halfway), B3 (T-2 & final day) |
| `task_expire_trials` | **hourly at :15** | B4 (trial ended) |
| `task_delete_expired_trial_data` | daily **00:20** | B5 (data deleted) |
| `task_promote_scheduled_downgrades` | daily **00:07** | C2 (downgrade re-auth, via transition_service) |
| `task_render_invoice_pdfs` | every 5 min (**:01,:06,…**) | C1 (invoice) |
| `task_invoice_reconciliation_alert` | daily **01:00** | *(none — alerts to **Sentry** only, not email)* |
| `task_renew_due_subscriptions` | daily **00:05** | may generate invoices → C1 downstream |

---

## 4. Summary

- **29 distinct emails** across 6 categories: Auth (4), Trial lifecycle (5), Billing (8), Lead/Live-chat (9), Affiliate (2), Team (1).
- **All 19 render raw HTML in code** from the shared design system (`app/services/email_design.py`); no Brevo saved templates are used to send. Legacy template IDs 57–63 remain for reference only.
- **Audiences:** customer/client, operator, and website **visitor** (transcript, visitor confirmation, missed callback).
- **Attachments:** only invoices (C1) attach a file (the PDF). The quotation document (D9) is inline-only.
- **All sends require `BREVO_API_KEY`** — otherwise skipped with a WARN log.
- **No credit metering** — emails do not deduct credits (the unwired `meter_customer_email()` stub was removed; registry reports `metered: false`).
- **Reply-To:** lead/live-chat emails forward the bot's `reply_to_email` and use a `"{BotName} via OyeChats"` sender so customers can reply directly.

> ✅ Resolved:
> - **Metering** — the unwired `meter_customer_email()` stub was removed; registry reports `metered: false`.
> - **One rendering path** — all 19 emails now render in code from `email_design.py`; the old Brevo-template split (and the transcript template mismatch) is gone. The `emails/gallery/` set is generated from these senders, so review == production.
>
> Follow-up (optional): the super-admin `email_templates` catalogue still describes the legacy Brevo templates; it could be repointed at the in-code design or removed since nothing sends through Brevo templates now.
