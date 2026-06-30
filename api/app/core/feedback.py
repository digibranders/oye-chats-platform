"""Canonical vocabularies for platform feedback classification.

Single source of truth shared by ``client_routes`` (submit), ``superadmin_routes``
(triage/filter), and the repository serializer. The admin TypeScript unions in
``oyechats-admin/src/lib/types.ts`` mirror these tuples — keep them in sync.
"""

FEEDBACK_TYPES = ("bug", "feature_request", "question", "other")
FEEDBACK_AREAS = ("billing", "bots", "knowledge", "live_chat", "dashboard", "widget", "other")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
FEEDBACK_STATUSES = ("open", "in_progress", "resolved", "closed")
# Statuses that "close the loop" — stamp resolved_at/by and notify the client.
FEEDBACK_RESOLVED_STATES = ("resolved", "closed")

# Legacy free-string ``category`` -> new ``type``. Anything unmapped becomes "other".
CATEGORY_TO_TYPE = {"bug": "bug", "feature": "feature_request"}

# Keys we persist from the client-supplied context blob (everything else dropped).
CONTEXT_KEYS = ("page_url", "app_version", "plan_tier", "user_agent")
