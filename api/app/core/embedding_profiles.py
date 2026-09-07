"""Embedding profiles: which model, dimension and task types produced a vector.

A vector is only comparable to vectors made the same way. Two things changed
that used to be implicit: every row in ``documents`` now records the profile
its ``embedding`` was made under, and every ``bots`` row records the profile
its queries (and its newly ingested chunks) must be made under. Vector search
compares a query only against chunks carrying the bot's own profile, and the
migration task (``worker.tasks.task_migrate_embedding_profile``) moves a bot
from one profile to the next one bot at a time, flipping the bot only once
every one of its chunks is on the new profile. That keeps a search from ever
ranking vectors from two different spaces against each other, which is the
failure mode that made an embedding-model change impossible before profiles
existed.

Profiles are opaque strings, ``<model>/<dimensions>/<revision>``. Bumping the
revision is how a change to the way vectors are produced is rolled out.

* ``v1``: ``gemini-embedding-001`` at 768 dimensions, Matryoshka-truncated and
  L2-normalised client-side, with NO task type. Query and document embeddings
  were made identically (symmetric), which is what every row carried before
  profiles existed and what the column's server default backfilled them to.
* ``v2``: the same model and dimensions, embedded with Gemini's asymmetric
  retrieval task types: ``RETRIEVAL_DOCUMENT`` for stored chunks and
  ``RETRIEVAL_QUERY`` for the visitor's question. The model is trained to
  place a short question near the passage that answers it under this pairing,
  which is the retrieval-quality lever the symmetric setup left on the table.

This module deliberately imports nothing from ``app``: ``db.models`` and the
embedding client both import it, and either of those importing the other is
a cycle.
"""

from __future__ import annotations

EMBEDDING_PROFILE_LEGACY = "gemini-embedding-001/768/v1"
EMBEDDING_PROFILE_CURRENT = "gemini-embedding-001/768/v2"

# profile -> (task type for stored chunks, task type for queries). ``None``
# means the request carries no ``taskType`` at all.
_TASK_TYPES: dict[str, tuple[str | None, str | None]] = {
    EMBEDDING_PROFILE_LEGACY: (None, None),
    EMBEDDING_PROFILE_CURRENT: ("RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"),
}

KNOWN_PROFILES: frozenset[str] = frozenset(_TASK_TYPES)


def normalize_profile(value: object) -> str:
    """The profile a stored value denotes, or the legacy profile for anything
    this code does not know. Unknown is treated as legacy on purpose: a row or
    bot stamped by a newer deploy that was then rolled back must be embedded
    the one way that is guaranteed to match what its vectors were made with,
    and inventing task types for an unknown profile is never that."""
    return value if isinstance(value, str) and value in _TASK_TYPES else EMBEDDING_PROFILE_LEGACY


def document_task_type(profile: str) -> str | None:
    """Gemini ``taskType`` for a chunk being stored under ``profile``."""
    return _TASK_TYPES[normalize_profile(profile)][0]


def query_task_type(profile: str) -> str | None:
    """Gemini ``taskType`` for a question being searched against ``profile``."""
    return _TASK_TYPES[normalize_profile(profile)][1]
