import os
from contextlib import contextmanager

# Create the SQLAlchemy engine
# pool_pre_ping=True handles broken connections
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import DB_URL

# ── Connection pool tuning ──────────────────────────────────────────────────
# This engine is imported by BOTH the API (Gunicorn) and the ARQ worker, and
# each PROCESS opens its own pool. Total DB connections must stay under the
# server's max_connections. Budget = (api_gunicorn_workers × api_pool) +
# (worker_procs × worker_pool). Defaults below are safe for a single Gunicorn
# worker (5 + 10 = max 15). Tune per process via env (the worker systemd unit
# sets its OWN smaller DB_POOL_SIZE/DB_MAX_OVERFLOW so its pool is sized to
# WORKER_MAX_JOBS, not the API's assumptions. Audit F30):
#   API, 1 gunicorn worker → pool_size=5, max_overflow=10  (max 15)
#   API, 2 gunicorn workers → pool_size=3, max_overflow=5  (max 16)
#   ARQ worker (WORKER_MAX_JOBS=5) → pool_size=5, max_overflow=5  (max 10)
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
        raise RuntimeError("DB_URL is not configured. Cannot create database session.")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_session():
    """Helper for non-FastAPI contexts (like pipeline)."""
    if SessionLocal is None:
        raise RuntimeError("DB_URL is not configured. Cannot create database session.")
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
