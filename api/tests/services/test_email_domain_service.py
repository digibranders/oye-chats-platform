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
