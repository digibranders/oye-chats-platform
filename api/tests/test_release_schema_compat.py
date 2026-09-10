"""The schema a deploy migrates to must still serve the release it replaces.

``deploy-api.yml`` runs ``alembic upgrade head`` before it restarts the API,
and its pre-restart rollback keeps the schema forward-migrated. So for the
window between the two, and for good if the restart never comes, the OLD code
runs on the NEW schema. Any column the old ORM maps must still exist.
"""

from __future__ import annotations

from pathlib import Path

from app.db.models import Bot, FailedEmail

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


class TestTheColumnThePreviousReleaseReadsIsStillThere:
    def test_qualification_flow_is_still_mapped(self):
        assert "qualification_flow" in Bot.__table__.c

    def test_no_migration_in_this_release_drops_it(self):
        offenders = [
            p.name for p in _VERSIONS.glob("*.py") if 'drop_column("bots", "qualification_flow")' in p.read_text()
        ]
        assert offenders == []


class TestTheModelDeclaresEveryIndexTheMigrationCreates:
    def test_failed_emails_status_created(self):
        names = {index.name for index in FailedEmail.__table__.indexes}
        assert "ix_failed_emails_status_created" in names
