import app.services.crawl_orchestrator as orch
import app.services.crawl_provider as provider
import app.services.crawler_service as crawler_service


def test_orchestrator_crawl_website_is_the_provider():
    """run_full_crawl must resolve crawl_website to the provider seam (which
    dispatches Playwright vs Spider), NOT the Playwright subprocess directly."""
    assert orch.crawl_website is provider.crawl_website
    assert orch.crawl_website is not crawler_service.crawl_website


def test_orchestrator_still_imports_shared_helpers_from_crawler_service():
    """The non-crawl helpers stay sourced from crawler_service."""
    assert orch.release_crawl_lock is crawler_service.release_crawl_lock
    assert orch.set_crawl_progress is crawler_service.set_crawl_progress
    assert orch.CrawlerError is crawler_service.CrawlerError
