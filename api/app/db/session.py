from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import DB_URL

# Create the SQLAlchemy engine
# pool_pre_ping=True handles broken connections
from sqlalchemy import text
from contextlib import contextmanager

# Create the SQLAlchemy engine
engine = create_engine(DB_URL, pool_pre_ping=True)

# Ensure pgvector extension exists (may require superuser)
try:
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
except Exception as e:
    print(f"Warning: Could not create 'vector' extension. pgvector might not be available: {e}")

# Create a SessionLocal class for instantiating sessions
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    """Dependency for FastAPI routes to get a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@contextmanager
def get_session():
    """Helper for non-FastAPI contexts (like pipeline)."""
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
