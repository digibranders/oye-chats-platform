"""Move the free trial off Starter and onto Standard (7 days).

Product decision (2026-07-14): Starter no longer offers a trial. The trial
now belongs to Standard for 7 days, because Standard is the tier we want
prospects to actually experience — it ships the full feature set (BANT,
webhooks, behavioural tracking) that Starter deliberately withholds.

Trial-gating machinery keys off ``Plan.trial_days`` in exactly one place
(``start_trial`` in ``plan_service.py``), so flipping the ``trial_days``
values turns the trial CTA on for Standard and off for Starter
simultaneously. Trials already in flight are unaffected — the expiry /
reminder crons filter on ``Subscription.status``, not on the plan's
current ``trial_days``.

This migration also patches the DB-side marketing copy the public
pricing page reads via ``/public/pricing-catalog``:

* ``plans.marketing.highlight_features`` — drop the "14-day free trial"
  bullet from Starter; add "7-day free trial" to Standard.
* ``plans.marketing.cta_label`` — Starter goes back to "Get started";
  Standard becomes "Start free trial".
* ``plans.marketing.cta_href`` — Standard's register URL flipped to
  ``?plan=standard`` so the Register page hint matches the CTA.
* ``pricing_config['pricing_faq']`` — the "Is there a free trial?"
  answer rewritten to reflect the new policy (Standard only, 7 days,
  one per account lifetime).

Revision ID: d9e2a4c7f108
Revises: 597bbddd6562
Create Date: 2026-07-14
"""

import json

import sqlalchemy as sa

from alembic import op

revision = "d9e2a4c7f108"
down_revision = "597bbddd6562"
branch_labels = None
depends_on = None


_APP = "https://app.oyechats.com"

_STARTER_TRIAL_BULLET = "14-day free trial"
_STANDARD_TRIAL_BULLET = "7-day free trial"

_FAQ_QUESTION = "Is there a free trial?"
_FAQ_ANSWER_NEW = (
    "Yes — the Standard plan includes a 7-day free trial with full access to every feature. "
    "No credit card required. Free trials are limited to one per account, lifetime."
)
_FAQ_ANSWER_OLD = (
    "Yes, Starter and Standard plans include a 14-day free trial with full access to all features. "
    "No credit card required."
)


def _patch_marketing(conn, slug: str, mutator) -> None:
    """Load ``plans.marketing`` for ``slug``, run ``mutator(dict)``, write it back.

    ``mutator`` mutates the dict in place. We round-trip through Python so
    downgrade can restore the exact prior copy without needing every
    branch of ``jsonb_set`` for list operations.
    """
    row = conn.execute(sa.text("SELECT marketing FROM plans WHERE slug = :s"), {"s": slug}).first()
    if row is None:
        return
    marketing = dict(row[0] or {})
    mutator(marketing)
    conn.execute(
        sa.text("UPDATE plans SET marketing = CAST(:m AS JSONB) WHERE slug = :s"),
        {"s": slug, "m": json.dumps(marketing)},
    )


def _patch_faq(conn, new_answer: str) -> None:
    """Rewrite the "Is there a free trial?" entry in the FAQ JSONB blob.

    The blob is a list of ``{"q": ..., "a": ...}`` objects. If the entry
    is missing (fresh DB before b3d7f1a9c2e5 seed) we no-op — the seed
    migration owns creation, not us.
    """
    row = conn.execute(
        sa.text("SELECT value FROM pricing_config WHERE key = 'pricing_faq'"),
    ).first()
    if row is None:
        return
    faq = list(row[0] or [])
    changed = False
    for entry in faq:
        if isinstance(entry, dict) and entry.get("q") == _FAQ_QUESTION:
            entry["a"] = new_answer
            changed = True
            break
    if changed:
        conn.execute(
            sa.text("UPDATE pricing_config SET value = CAST(:v AS JSONB) WHERE key = 'pricing_faq'"),
            {"v": json.dumps(faq)},
        )


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Flip the source-of-truth trial durations.
    conn.execute(sa.text("UPDATE plans SET trial_days = 0 WHERE slug = 'starter'"))
    conn.execute(sa.text("UPDATE plans SET trial_days = 7 WHERE slug = 'standard'"))

    # 2. Starter marketing — drop the trial bullet, revert CTA to paid-path.
    def _demote_starter(m: dict) -> None:
        features = [f for f in (m.get("highlight_features") or []) if f != _STARTER_TRIAL_BULLET]
        m["highlight_features"] = features
        m["cta_label"] = "Get started"
        m["cta_href"] = f"{_APP}/register?plan=starter"

    _patch_marketing(conn, "starter", _demote_starter)

    # 3. Standard marketing — surface the new trial bullet + CTA.
    def _promote_standard(m: dict) -> None:
        features = list(m.get("highlight_features") or [])
        if _STANDARD_TRIAL_BULLET not in features:
            features.append(_STANDARD_TRIAL_BULLET)
        m["highlight_features"] = features
        m["cta_label"] = "Start free trial"
        m["cta_href"] = f"{_APP}/register?plan=standard"

    _patch_marketing(conn, "standard", _promote_standard)

    # 4. FAQ blob — rewrite the trial answer.
    _patch_faq(conn, _FAQ_ANSWER_NEW)


def downgrade() -> None:
    conn = op.get_bind()

    conn.execute(sa.text("UPDATE plans SET trial_days = 14 WHERE slug = 'starter'"))
    conn.execute(sa.text("UPDATE plans SET trial_days = 0 WHERE slug = 'standard'"))

    def _restore_starter(m: dict) -> None:
        features = list(m.get("highlight_features") or [])
        if _STARTER_TRIAL_BULLET not in features:
            # Best-effort restore near the historical position (after "Live chat enabled");
            # if that anchor is missing we simply append.
            try:
                idx = features.index("Live chat enabled") + 1
                features.insert(idx, _STARTER_TRIAL_BULLET)
            except ValueError:
                features.append(_STARTER_TRIAL_BULLET)
        m["highlight_features"] = features
        m["cta_label"] = "Start free trial"
        m["cta_href"] = f"{_APP}/register?plan=starter"

    _patch_marketing(conn, "starter", _restore_starter)

    def _restore_standard(m: dict) -> None:
        m["highlight_features"] = [f for f in (m.get("highlight_features") or []) if f != _STANDARD_TRIAL_BULLET]
        m["cta_label"] = "Get started"
        m["cta_href"] = f"{_APP}/register?plan=standard"

    _patch_marketing(conn, "standard", _restore_standard)

    _patch_faq(conn, _FAQ_ANSWER_OLD)
