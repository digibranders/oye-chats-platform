import os
from contextlib import contextmanager

# Create the SQLAlchemy engine
# pool_pre_ping=True handles broken connections
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import DB_URL

# ── Connection pool tuning ──────────────────────────────────────────────────
# These defaults are safe for a single Gunicorn worker (5 + 10 = max 15).
# When running multiple workers, reduce per-worker limits to stay within
# the database's max_connections (e.g. DigitalOcean managed PG = 25):
#   1 worker → pool_size=5, max_overflow=10  (max 15)
#   2 workers → pool_size=3, max_overflow=5  (max 16)
#   4 workers → pool_size=2, max_overflow=3  (max 20)
_DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
_DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "10"))
_DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30"))
_DB_POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))

# When DB_URL is not set (e.g. unit tests that mock the session),
# skip engine creation so the module can still be imported.
if DB_URL:
    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        pool_size=_DB_POOL_SIZE,
        max_overflow=_DB_MAX_OVERFLOW,
        pool_timeout=_DB_POOL_TIMEOUT,
        pool_recycle=_DB_POOL_RECYCLE,
    )

    # Ensure pgvector extension exists (may require superuser)
    try:
        with engine.connect() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            conn.commit()
    except Exception as e:
        print(f"Warning: Could not create 'vector' extension. pgvector might not be available: {e}")

    # Create a SessionLocal class for instantiating sessions
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
else:
    engine = None
    SessionLocal = None


def get_db():
    """Dependency for FastAPI routes to get a DB session."""
    if SessionLocal is None:
        raise RuntimeError("DB_URL is not configured — cannot create database session.")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_session():
    """Helper for non-FastAPI contexts (like pipeline)."""
    if SessionLocal is None:
        raise RuntimeError("DB_URL is not configured — cannot create database session.")
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
