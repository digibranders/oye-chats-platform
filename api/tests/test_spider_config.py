import importlib


def test_spider_defaults(monkeypatch):
    # Isolate from the developer's local .env so we test the code defaults.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in ("SPIDER_API_KEY", "SPIDER_API_URL", "SPIDER_REQUEST_MODE", "SPIDER_TIMEOUT"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg

    importlib.reload(cfg)
    assert cfg.SPIDER_API_URL == "https://api.spider.cloud"
    assert cfg.SPIDER_REQUEST_MODE == "smart"
    assert cfg.SPIDER_TIMEOUT == 1600


def test_spider_key_via_env(monkeypatch):
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("SPIDER_API_KEY", "sk-test")
    import app.config as cfg

    importlib.reload(cfg)
    assert cfg.SPIDER_API_KEY == "sk-test"


def test_jina_fallback_defaults(monkeypatch):
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in ("JINA_API_KEY", "JINA_READER_URL", "JINA_FALLBACK_ENABLED", "JINA_FETCH_CONCURRENCY"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg

    importlib.reload(cfg)
    assert cfg.JINA_FALLBACK_ENABLED is True  # fallback on by default (Jina is PAYG, off-box)
    assert cfg.JINA_READER_URL == "https://r.jina.ai"
    assert cfg.JINA_FETCH_CONCURRENCY == 5


def teardown_module(module):
    import importlib

    import app.config as cfg

    importlib.reload(cfg)
