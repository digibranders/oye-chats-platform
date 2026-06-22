"""Delete BANT signals that were extracted from routing-intent messages.

Background — see ``app/services/rag_service.py``'s ``_HANDOFF_INTENT_PATTERNS``
and the broader extraction prompt rewrite shipped in mid-2026: the extractor
historically treated "Connect me with support" / "Last year we spent 50k on
tools" / similar messages as positive BANT signals. The fix prevents new bad
signals but doesn't touch existing rows because the never-downgrade rule
inside ``_background_bant_extraction`` blocks corrections from new
extractions.

This script walks ``BANTSignal`` rows whose ``signal_text`` matches the
known bad patterns, deletes them, then rebuilds each affected
``ChatSession``'s aggregate ``bant_need_score`` / ``bant_budget_score`` /
``bant_authority_score`` / ``bant_timeline_score`` / ``bant_score`` /
``bant_tier`` from the remaining valid signals.

## Usage

    # Dry run — count what would be deleted, report per-session impact.
    python -m scripts.cleanup_bant_routing_signals

    # Apply the changes.
    python -m scripts.cleanup_bant_routing_signals --apply

    # Scope to a single client (defensive — start narrow before going broad).
    python -m scripts.cleanup_bant_routing_signals --client-id 42 --apply

    # Reset bant_tier even when no signals were deleted (e.g. a tier was
    # cached above the recalculated score for some other reason).
    python -m scripts.cleanup_bant_routing_signals --force-recompute-tiers --apply

## Idempotency

Safe to re-run. After the first ``--apply`` pass there are no matching rows
left, so subsequent dry runs report 0 deletions and the recompute step
becomes a no-op for unaffected sessions.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

# Allow running as ``python scripts/cleanup_bant_routing_signals.py`` from the
# project root by pushing ``api/`` onto sys.path so ``app.*`` imports resolve.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from sqlalchemy import func, select  # noqa: E402

from app.db.models import BANTSignal, ChatSession  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.services.qualification_service import get_framework_config, get_tier  # noqa: E402

# ── Bad-signal pattern surface ────────────────────────────────────────────
#
# Mirror of ``_HANDOFF_INTENT_PATTERNS`` from rag_service. Kept inline so the
# cleanup script does not depend on a private regex constant that may move
# or get renamed without notice.

_ROUTING_INTENT_PATTERNS = re.compile(
    r"\b(talk|speak|connect|chat)(\s+\w+){0,2}\s+(to|with)\s+(an?\s+)?"
    r"(human|person|agent|operator|someone|support|team|representative|rep)\b"
    r"|\b(real|live)\s+(person|human|agent|support)\b"
    r"|\b(can|could)\s+(i|you|someone)\s+(get|have\s+some\s+)?help\b"
    r"|\bget\s+me\s+(an?\s+)?(human|person|agent|someone)\b"
    r"|\b(hand\s*off|handoff|handover)\b",
    re.IGNORECASE,
)

# Past-spend Budget false positives: "last year we spent 50k on tools",
# "we paid 5k a month last year", "we burned through 20k", etc. The
# distinguishing feature is past-tense + dollar/INR amounts.
_PAST_SPEND_PATTERNS = re.compile(
    r"\b(last\s+(year|quarter|month)|previously|before|earlier)\b"
    r"|\bwe('?ve|\s+have)?\s+(spent|paid|burned|wasted|burnt)\b"
    r"|\b(cost|costed)\s+us\b",
    re.IGNORECASE,
)


def _is_bad_signal(signal: BANTSignal) -> bool:
    """True if a signal looks like one of the known false-positive families.

    Two checks:
    * Any dimension where ``signal_text`` matches the routing-intent
      family — these were Need false positives in practice but the pattern
      can drift across dimensions, so we treat any match as bad.
    * Specifically for ``budget`` dimension, past-spend phrasing.

    Falls through to False for genuine signals (specific amounts, present
    tense, real authority statements, etc.).
    """
    text = (signal.signal_text or "").strip()
    if not text:
        return False
    if _ROUTING_INTENT_PATTERNS.search(text):
        return True
    return bool(signal.dimension == "budget" and _PAST_SPEND_PATTERNS.search(text))


# ── Recompute helpers ─────────────────────────────────────────────────────


def _recompute_session_scores(
    session,
    chat_session: ChatSession,
    *,
    apply: bool,
    exclude_signal_ids: set[int] | None = None,
) -> dict:
    """Recalculate aggregate scores for a chat_session from its remaining
    BANT signals. Returns a per-session diff dict for reporting.

    During ``--apply`` runs the bad signals are deleted before this is
    called, so the simple ``WHERE session_id`` query naturally excludes
    them. During dry runs the rows still exist, so the caller passes
    ``exclude_signal_ids`` to simulate what the recompute would produce
    AFTER the deletion lands.
    """
    stmt = select(BANTSignal).where(BANTSignal.session_id == chat_session.id)
    if exclude_signal_ids:
        stmt = stmt.where(BANTSignal.id.notin_(exclude_signal_ids))
    remaining = session.execute(stmt).scalars().all()

    # Max score wins per dimension. The original pipeline also enforces
    # "never downgrade" but at recompute time we're reconstructing from
    # truth, so take the max of the remaining valid signals.
    per_dim_max: dict[str, int] = defaultdict(int)
    per_dim_value: dict[str, str] = {}
    for sig in remaining:
        dim = (sig.dimension or "").lower()
        score = int(sig.score_after or 0)
        if score > per_dim_max[dim]:
            per_dim_max[dim] = score
            per_dim_value[dim] = sig.extracted_value or ""

    before = {
        "need": int(chat_session.bant_need_score or 0),
        "budget": int(chat_session.bant_budget_score or 0),
        "authority": int(chat_session.bant_authority_score or 0),
        "timeline": int(chat_session.bant_timeline_score or 0),
        "tier": chat_session.bant_tier,
        "composite": int(chat_session.bant_score or 0),
    }

    new_scores = {
        "need": per_dim_max.get("need", 0),
        "budget": per_dim_max.get("budget", 0),
        "authority": per_dim_max.get("authority", 0),
        "timeline": per_dim_max.get("timeline", 0),
    }
    new_composite = sum(new_scores.values())

    config = get_framework_config(None)  # framework defaults
    thresholds = (config or {}).get("thresholds")
    new_tier = get_tier(new_composite, thresholds=thresholds)

    diff = {
        "session_id": chat_session.id,
        "before": before,
        "after": {
            **new_scores,
            "composite": new_composite,
            "tier": new_tier,
        },
        "changed": (
            new_scores["need"] != before["need"]
            or new_scores["budget"] != before["budget"]
            or new_scores["authority"] != before["authority"]
            or new_scores["timeline"] != before["timeline"]
            or new_tier != before["tier"]
        ),
    }

    if apply and diff["changed"]:
        chat_session.bant_need_score = new_scores["need"]
        chat_session.bant_budget_score = new_scores["budget"]
        chat_session.bant_authority_score = new_scores["authority"]
        chat_session.bant_timeline_score = new_scores["timeline"]
        chat_session.bant_score = new_composite
        chat_session.bant_tier = new_tier
        # Clear text fields for dimensions that are back to zero.
        if new_scores["need"] == 0:
            chat_session.bant_need = None
        if new_scores["budget"] == 0:
            chat_session.bant_budget = None
        if new_scores["authority"] == 0:
            chat_session.bant_authority = None
        if new_scores["timeline"] == 0:
            chat_session.bant_timeline = None

    return diff


# ── Main ──────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Persist deletions + score recomputes. Without this, dry-run only.",
    )
    parser.add_argument(
        "--client-id",
        type=int,
        default=None,
        help="Scope cleanup to a single client_id (defensive narrow rollout).",
    )
    parser.add_argument(
        "--force-recompute-tiers",
        action="store_true",
        help="Recompute every session's tier even if no signals were deleted.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap signals scanned (debugging convenience; default = no cap).",
    )
    args = parser.parse_args()

    print(f"BANT cleanup — mode: {'APPLY' if args.apply else 'DRY RUN'}")
    if args.client_id is not None:
        print(f"Scope: client_id = {args.client_id}")

    with get_session() as session:
        # 1. Find candidate bad signals.
        stmt = select(BANTSignal)
        if args.client_id is not None:
            # BANTSignal doesn't have client_id directly — join via ChatSession.
            stmt = stmt.join(ChatSession, BANTSignal.session_id == ChatSession.id).where(
                ChatSession.client_id == args.client_id
            )
        if args.limit:
            stmt = stmt.limit(args.limit)

        all_signals = list(session.execute(stmt).scalars().all())
        bad = [s for s in all_signals if _is_bad_signal(s)]
        affected_session_ids = {s.session_id for s in bad}

        print(f"\nScanned {len(all_signals)} BANT signals.")
        print(f"Identified {len(bad)} bad signals across {len(affected_session_ids)} sessions.")

        # Print a sample of what we found so a human can sanity-check before --apply.
        if bad and not args.apply:
            print("\nSample of bad signals (first 10):")
            for sig in bad[:10]:
                print(
                    f"  - session={sig.session_id} dim={sig.dimension} "
                    f"score={sig.score_after} text={(sig.signal_text or '')[:80]!r}"
                )

        # 2. Delete the bad signals.
        if args.apply:
            for sig in bad:
                session.delete(sig)
            session.flush()

        # 3. Recompute affected sessions.
        recompute_targets = set(affected_session_ids)
        if args.force_recompute_tiers:
            # Recompute every session in scope, not just the affected ones.
            scope_stmt = select(ChatSession.id)
            if args.client_id is not None:
                scope_stmt = scope_stmt.where(ChatSession.client_id == args.client_id)
            recompute_targets |= set(session.execute(scope_stmt).scalars().all())

        # On dry runs we need the recompute to simulate what would happen
        # AFTER the bad signals are deleted; pass the ids forward as an
        # exclusion set. On apply runs they've already been removed from
        # the session and the parameter is harmless.
        bad_signal_ids = {s.id for s in bad}

        diffs = []
        for sid in recompute_targets:
            cs = session.get(ChatSession, sid)
            if cs is None:
                continue
            diffs.append(
                _recompute_session_scores(
                    session,
                    cs,
                    apply=args.apply,
                    exclude_signal_ids=bad_signal_ids,
                )
            )

        changed = [d for d in diffs if d["changed"]]
        print(f"\nRecomputed {len(diffs)} sessions; {len(changed)} would change.")

        # Print first 10 diffs as a sample for spot-checking.
        for d in changed[:10]:
            print(
                f"  - session={d['session_id']} "
                f"need {d['before']['need']}→{d['after']['need']}, "
                f"budget {d['before']['budget']}→{d['after']['budget']}, "
                f"authority {d['before']['authority']}→{d['after']['authority']}, "
                f"timeline {d['before']['timeline']}→{d['after']['timeline']}, "
                f"composite {d['before']['composite']}→{d['after']['composite']}, "
                f"tier {d['before']['tier']}→{d['after']['tier']}"
            )

        # 4. Commit if applying.
        if args.apply:
            session.commit()
            print("\n✓ Changes committed.")
        else:
            print("\nDry run complete — no changes persisted. Re-run with --apply to commit.")

        # Aggregate stats.
        if args.apply:
            with get_session() as s2:
                total_signals_left = s2.execute(select(func.count(BANTSignal.id))).scalar_one()
                print(f"Total BANTSignal rows remaining in DB: {total_signals_left}")


if __name__ == "__main__":
    main()
