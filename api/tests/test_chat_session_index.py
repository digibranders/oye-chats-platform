"""chat_sessions.client_id must be indexed (audit F27).

Analytics queries filter chat_sessions by client_id; without an index they
sequential-scan a hot, growing table. Guards against the index being dropped.
"""

from app.db.models import ChatSession


def test_chat_sessions_client_id_is_indexed():
    indexed_columns = {tuple(c.name for c in ix.columns) for ix in ChatSession.__table__.indexes}
    assert ("client_id",) in indexed_columns
