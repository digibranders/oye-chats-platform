import importlib


def test_spider_defaults(monkeypatch):
    # Isolate from the developer's local .env so we test the code defaults,
    # not whatever CRAWL_PROVIDER happens to be set there.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in ("CRAWL_PROVIDER", "SPIDER_API_KEY", "SPIDER_API_URL",
              "SPIDER_REQUEST_MODE", "SPIDER_TIMEOUT", "SPIDER_FALLBACK_TO_PLAYWRIGHT"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.CRAWL_PROVIDER == "playwright"          # safe default: no behavior change on deploy
    assert cfg.SPIDER_API_URL == "https://api.spider.cloud"
    assert cfg.SPIDER_TIMEOUT == 1600
    assert cfg.SPIDER_FALLBACK_TO_PLAYWRIGHT is True


def test_spider_enabled_via_env(monkeypatch):
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("CRAWL_PROVIDER", "spider")
    monkeypatch.setenv("SPIDER_API_KEY", "sk-test")
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.CRAWL_PROVIDER == "spider"
    assert cfg.SPIDER_API_KEY == "sk-test"


def teardown_module(module):
    # Restore config to the real environment for any later tests in the session.
    import importlib

    import app.config as cfg
    importlib.reload(cfg)
