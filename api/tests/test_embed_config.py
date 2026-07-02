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


def test_empty_env_falls_back_to_defaults(monkeypatch):
    # Reproduces the prod deploy failure: absent secrets arrive as "" (not unset),
    # and int("") crashed config on import. Empty must fall back to defaults.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in (
        "EMBED_DIMENSIONS",
        "EMBED_PROVIDER",
        "GEMINI_EMBED_MODEL",
        "JINA_FALLBACK_ENABLED",
        "SPIDER_REQUEST_MODE",
        "SPIDER_TIMEOUT",
    ):
        monkeypatch.setenv(k, "")  # empty, not unset

    import app.config as cfg

    importlib.reload(cfg)  # must not raise
    assert cfg.EMBED_DIMENSIONS == 768
    assert cfg.EMBED_PROVIDER == "google"
    assert cfg.GEMINI_EMBED_MODEL == "gemini-embedding-001"
    assert cfg.JINA_FALLBACK_ENABLED is True
    assert cfg.SPIDER_REQUEST_MODE == "smart"
    assert cfg.SPIDER_TIMEOUT == 1600


def teardown_module(module):
    import importlib

    import app.config as cfg

    importlib.reload(cfg)
