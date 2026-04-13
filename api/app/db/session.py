from contextlib import contextmanager

# Create the SQLAlchemy engine
# pool_pre_ping=True handles broken connections
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import DB_URL

# When DB_URL is not set (e.g. unit tests that mock the session),
# skip engine creation so the module can still be imported.
if DB_URL:
    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
        pool_recycle=1800,
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
