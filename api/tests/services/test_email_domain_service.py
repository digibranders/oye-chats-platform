from app.services.email_domain_service import extract_company_domain


def test_extracts_domain_from_business_email():
    assert extract_company_domain("priya@xyz.com") == "xyz.com"


def test_returns_none_for_free_email_provider():
    assert extract_company_domain("priya@gmail.com") is None
    assert extract_company_domain("priya@yahoo.com") is None
    assert extract_company_domain("priya@outlook.com") is None
    assert extract_company_domain("priya@icloud.com") is None


def test_returns_none_for_malformed_email():
    assert extract_company_domain("not-an-email") is None
    assert extract_company_domain("") is None
    assert extract_company_domain(None) is None


def test_lowercases_and_strips_domain():
    assert extract_company_domain("Priya@XYZ.COM ") == "xyz.com"


def test_subdomain_is_reduced_to_the_registrable_domain():
    """Every employee of one company must produce ONE cache key, whatever
    subdomain their mail sits on. Previously returned 'mail.acme.co.uk',
    which would have created a separate company_profile row per subdomain."""
    assert extract_company_domain("bob@mail.acme.co.uk") == "acme.co.uk"
    assert extract_company_domain("bob@mail.acme.com") == "acme.com"
    assert extract_company_domain("bob@deep.sub.acme.com") == "acme.com"


def test_platform_hosted_domains_keep_the_customer_label():
    """acme.myshopify.com must not collapse onto the platform — that key is
    shared across every tenant."""
    assert extract_company_domain("bob@acme.myshopify.com") == "acme.myshopify.com"


def test_public_suffix_alone_is_not_a_company():
    assert extract_company_domain("bob@co.uk") is None
    assert extract_company_domain("bob@myshopify.com") is None


def test_ip_literal_is_not_a_company():
    assert extract_company_domain("bob@192.168.1.1") is None
