# OyeChats email gallery

All **19** transactional/lifecycle emails the platform sends, rendered as standalone,
self-contained HTML in one folder. Open `index.html` for the browsable grid.

## Design system

Monochrome + single-accent, inspired by Stripe / Linear / Vercel (the research
that drove this lives in the redesign brief). Key rules:

- **One accent** — indigo `#4f46e5` for buttons, links, and the wordmark only.
  Green / amber / red appear **only** in small status chips and alert boxes,
  never as full-email theming.
- **Ink-forward** — near-black headings `#1a1a1d`, slate body `#5b616e`, generous
  whitespace, hairline dividers `#e6e8eb`. Never pure `#fff`/`#000` (they trigger
  the most aggressive dark-mode inversion).
- **600px** single-column, table-based layout, system fonts only.
- **Bulletproof buttons** — VML `<v:roundrect>` for Outlook + HTML fallback,
  4–6px radius (square-ish, not pills), full-width on mobile.

## Dark mode (Outlook-safe)

Every surface, ink, fill, chip, and alert carries an `oc-*` class with a dark
override applied three ways so inversion looks *intentional* instead of mangled:

1. `@media (prefers-color-scheme: dark)` — Apple Mail, iOS, modern clients.
2. `[data-ogsc]` / `[data-ogsb]` descendant selectors — Outlook.com / Outlook
   dark mode (the client that fully recolors emails).

Toggle your OS to dark mode and reload `index.html` to preview.

## Regenerating

These files are generated — do not hand-edit. Edit the generator and re-run:

```bash
cd platform/api
uv run python scripts/build_email_gallery.py
```

## Status

This is a **design deliverable** for review. It is decoupled from the runtime
`app.services.email_service`. Once approved, the tokens and components here get
ported back into the runtime helpers so the actually-sent emails match (the
"wire-up" step). Until then, production still sends the current templates.

## The 19 templates

| # | File | Category | Audience |
|---|------|----------|----------|
| 1 | `verification-otp.html` | Auth | Customer |
| 2 | `password-reset.html` | Auth | Customer |
| 3 | `email-change-otp.html` | Auth | Customer (new address) |
| 4 | `email-change-notice.html` | Auth | Customer (old address) |
| 5 | `trial-welcome.html` | Trial | Customer |
| 6 | `trial-day7.html` | Trial | Customer |
| 7 | `trial-days-left.html` | Trial | Customer |
| 8 | `trial-ended.html` | Trial | Customer |
| 9 | `trial-data-deleted.html` | Trial | Customer |
| 10 | `invoice.html` | Billing | Customer |
| 11 | `downgrade-reauth.html` | Billing | Customer |
| 12 | `qualified-lead.html` | Lead | Customer |
| 13 | `handoff-request.html` | Live chat | Operator |
| 14 | `missed-callback.html` | Live chat | Customer |
| 15 | `offline-message.html` | Live chat | Customer |
| 16 | `visitor-confirmation.html` | Live chat | Visitor |
| 17 | `chat-transcript.html` | Post-chat | Visitor |
| 18 | `affiliate-welcome.html` | Affiliate | Customer |
| 19 | `affiliate-invite.html` | Affiliate | Prospect |
