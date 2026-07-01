import importlib


def test_embed_defaults(monkeypatch):
    # Isolate from the developer's local .env so we test code defaults.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in ("EMBED_PROVIDER", "GEMINI_EMBED_MODEL", "GEMINI_EMBED_URL", "EMBED_DIMENSIONS"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg

    importlib.reload(cfg)
    assert cfg.EMBED_PROVIDER == "google"
    assert cfg.GEMINI_EMBED_MODEL == "gemini-embedding-001"
    assert cfg.GEMINI_EMBED_URL == "https://generativelanguage.googleapis.com/v1beta"
    assert cfg.EMBED_DIMENSIONS == 768


def test_embed_provider_normalized(monkeypatch):
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("EMBED_PROVIDER", "  Google  ")
    import app.config as cfg

    importlib.reload(cfg)
    assert cfg.EMBED_PROVIDER == "google"


def teardown_module(module):
    import importlib

    import app.config as cfg

    importlib.reload(cfg)
