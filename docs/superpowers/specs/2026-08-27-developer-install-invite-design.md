# Emailing the install snippet to a developer

**Status:** approved · **SHIPPED** — see the note below
**Date:** 2026-08-27
**Surface:** `/chatbots/:id/deploy` — the Snippet card

> **Status update, 2026-08-31 (documentation audit).** The design body below is left
> unedited — it is the record of what was decided and why. Only this line is added, because
> the header said "not yet implemented" and that is no longer true: the server-side send
> exists at `api/app/api/bot_routes.py:3117`, whose own docstring opens *"Replaces a
> `mailto:` link, which handed the briefing to the operating system…"* — the exact problem
> §"The problem" describes. Verify the three consequences it lists (silent no-op without a
> mail client, a tick that means "you clicked", and the false `install_snippet_copied`
> activation event) are each actually closed before treating the whole spec as discharged;
> the audit confirmed the endpoint's existence, not every downstream behaviour.

## The problem

"Email this to my developer" on the Deploy page is an `<a href="mailto:…">`.
It hands the briefing to the operating system and loses sight of it. Three
consequences:

1. On a machine with no mail client configured, clicking it does nothing
   visible. The button looks broken because, from the customer's side, it is.
2. The green tick beside the label is `useState(emailed)` flipping on click. It
   means "you clicked", not "it sent", and it resets on reload.
3. The click emits the activation event `install_snippet_copied`. Nothing was
   copied. The funnel is being fed a false milestone.

The buyer is very often not the installer, so this is a first-class path out of
the page, not a fallback. It should send, and it should know that it sent.

## What we are building

Clicking the button reveals an email field and a Send button. Our server sends
the briefing. The chatbot remembers who it went to and when, so the card still
says so after a reload. Sending again to the same address asks for confirmation
first. Sending to a different address just sends.

## Data

Two nullable columns on `bots`, alongside the existing `widget_installed_at`:

| Column | Type | Meaning |
|---|---|---|
| `dev_invite_email` | `String`, nullable | The last address we sent the briefing to. NULL = never sent. |
| `dev_invite_sent_at` | `DateTime(timezone=True)`, nullable | When that send happened. |

Per chatbot rather than per account, because the snippet is per chatbot and so
is the question the card answers.

Only the most recent send is kept. A full history table was considered and
rejected under YAGNI: nothing in the product reads a history, and the single
last-send pair answers both questions the UI asks ("has this gone out?" and "to
whom, when?").

`ActivationEvent` is **not** the store of record. It is append-only
instrumentation with no client-facing read endpoint, and its own docstring
says it is not a document store.

Migration chains off `a4d7f2c91b06` (`bot_widget_heartbeat`), confirmed as the
single head via `alembic heads`. Downgrade drops both columns.

Both fields are added to the bot response schema, so `DeployPage` reads them
the same way it already reads `widget_installed_at`.

## Backend

`POST /bots/{bot_id}/install-invite`

- **Auth:** the authenticated client must own the bot, matching the other
  per-bot routes in `bot_routes.py`.
- **Body:** `{ "email": EmailStr }`.
- **Rate limit:** `@limiter.limit("5/hour")`. An authenticated endpoint that
  mails an arbitrary address is a spam vector attached to our sending domain's
  reputation. Five is far above what a genuine handoff needs and low enough
  that the endpoint is worthless for bulk.
- **Response:** `{ email, sent_at, resent: bool }`, where `resent` is true when
  this address matched `dev_invite_email` before the write.

The confirm step is driven client-side from the bot payload, not by `resent`:
the page already knows the last recipient, so it can ask before spending a
request. `resent` is the server's authoritative echo, used to update local
state after the send and to stay correct when a second device or tab sent the
same invite in between.

The send goes through `send_email_async` (ARQ when `WORKER_ENABLED`, thread-pool
fallback otherwise), with:

- **`reply_to`** set to the account owner's email. The developer is a third
  party who never signed up with us. A reply must reach the colleague who asked
  them, not our support inbox.
- **Body** carrying the same content the mailto briefing has today: the snippet,
  the "it goes in `<body>`, not `<head>`" note, the two Content-Security-Policy
  origins, and the attribution paragraph when the workspace's plan carries the
  credit link.
- **Attribution correctness.** The snippet is built from the same entitlement
  the page uses. The endpoint recomputes it server-side rather than accepting a
  snippet from the client, so a customer cannot mail themselves a white-label
  snippet they are not entitled to.

Rendered with the existing `email_design` helpers (`h1`, `p`, `code_box`,
`shell`), so it reads like every other transactional email we send.

The columns are stamped after the send is queued. An activation event
`install_invite_sent` is emitted, and the false `install_snippet_copied` on
this button is removed.

## Frontend

In `SnippetSection.tsx`, the anchor becomes a disclosure.

**Closed (never sent):** the button reads "Email this to my developer".

**Open:** an email input and a Send button appear below it, in the same
`CardSection`. Beside Send, a quiet "open in my mail app instead" link keeps
the old mailto path for the customer who does not know the address by heart and
wants to pick from their own contacts. That path stays untracked, by nature.

**Sent:** the row collapses to "Sent to dev@acme.com just now", with a
"Send again" control that reopens the field pre-filled. The timestamp uses the
console's existing relative-time helper, so it stays readable a week later.

**Repeat send to the same address:** a confirm step, not a block. "Already sent
to dev@acme.com on 27 Aug. Send it again?" Sending is still one click away.

**Repeat send to a different address:** sends without a prompt. A second
developer is a new handoff, not an accidental duplicate. This is what keeps the
warning meaningful.

On mount the sent state comes from the bot payload, so it is correct after a
reload and on another device.

## Failure handling

| Case | Behaviour |
|---|---|
| Invalid address | Caught client-side before the request. The field shows the error. |
| Rate limit hit | The limit is stated plainly, not surfaced as a generic failure. |
| Request fails | An error alert. The typed address stays in the input so the send can be retried without retyping. |
| Queue accepts, delivery later fails | Reported as sent, because that is what we know. Delivery failure is invisible to this endpoint by design: the send is fire-and-forget. |

## Testing

**Backend**
- A client that does not own the bot is rejected.
- A successful send stamps both columns.
- Sending to the stored address returns `resent: true`; a new address returns
  `resent: false` and overwrites the stored pair.
- The rate limit triggers.
- A workspace entitled to remove branding gets a snippet without the
  attribution anchor, and one that is not gets it with.

**Frontend**
- The button opens the field rather than navigating.
- An invalid address does not fire a request.
- A bot arriving with `dev_invite_sent_at` set renders the sent state on mount.
- Re-sending to the same address shows the confirm step, and confirming sends.
- A different address sends without the confirm step.

## Rejected alternatives

**Keep mailto and only prefill the recipient.** No backend and nothing to
abuse, but the tracking requirement cannot be met honestly: we would be showing
"already sent" for an email we only know was drafted.

**Warn on every repeat send regardless of address.** One flag instead of two
columns, but it cries wolf when the customer is deliberately emailing a second
developer, and a warning that fires when nothing is wrong stops being read.

**A full send-history table.** More honest and auditable, but it is a new table
and more UI than the problem needs, and nothing today would read it.
