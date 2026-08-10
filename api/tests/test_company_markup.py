"""Company identity from a site's own markup, no LLM.

Fixtures are the REAL markup patterns captured from live lead domains on
2026-08-10 — do not "simplify" them into idealised HTML. Two bugs shipped
earlier the same day because tests asserted an invented payload shape.
"""

import pytest

from app.services.company_markup import extract_from_markup, extract_logo

# fynix.digital — og:site_name only, title carries a tagline after a pipe.
FYNIX = """
<html><head>
<title>Fynix Digital | A digital marketing company</title>
<meta property="og:site_name" content="Fynix Digital">
<meta property="og:description" content="Branding, design and performance marketing.">
<meta property="og:image" content="https://fynix.digital/og.png">
</head><body></body></html>
"""

# cleanstart.com — schema.org carries the LEGAL entity; the title is pure SEO copy.
CLEANSTART = """
<html><head>
<title>Verified, zero-CVE container images and linux packages</title>
<meta property="og:site_name" content="CleanStart">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","name":"CleanStart, Inc.",
 "url":"https://cleanstart.com"}
</script>
</head><body></body></html>
"""

# digibranders.com — brand sits AFTER the separator in the title.
DIGIBRANDERS = """
<html><head>
<title>Digital Marketing Company | Digibranders</title>
<meta property="og:site_name" content="Digibranders">
</head><body></body></html>
"""

# zomato.com — no markup at all; a clean one-word title is the only signal.
ZOMATO = "<html><head><title>Zomato</title></head><body></body></html>"

# A site with nothing usable — must fall through to the LLM.
BARE = "<html><head><title>Home</title></head><body>Welcome!</body></html>"


def test_schema_org_organization_wins_over_og_site_name():
    """schema.org gives the legal entity, which is the more precise answer."""
    result = extract_from_markup(CLEANSTART, "cleanstart.com")
    assert result["name"] == "CleanStart, Inc."


def test_og_site_name_used_when_no_schema_org():
    result = extract_from_markup(FYNIX, "fynix.digital")
    assert result["name"] == "Fynix Digital"
    assert result["description"] == "Branding, design and performance marketing."
    assert result["logo_url"] == "https://fynix.digital/og.png"


@pytest.mark.parametrize(
    ("title", "domain"),
    [
        # Every one of these was a reproduced false positive when <title> was
        # mined as a third tier. They must now all fall through to the LLM.
        ("Digital Marketing Company | Digibranders", "digibranders.com"),
        ("Zomato", "zomato.com"),
        ("Kumar Textiles | Surat", "kumartextiles.com"),
        ("Shah Industries | Steel Supplier | Mumbai", "mumbaisteel.com"),
        ("Sitio en construcción", "x.com"),
        ("Just another WordPress site", "x.com"),
        ("Diese Domain ist reserviert", "x.com"),
    ],
)
def test_title_is_never_a_source(title, domain):
    """`<title>` is written for search engines, not machines — nothing in it is
    a declaration. Three separate classes of wrong answer came out of mining
    it, so it was removed rather than tuned further. See the module docstring.
    """
    html = f"<html><head><title>{title}</title></head></html>"
    assert extract_from_markup(html, domain) is None


def test_seo_sentence_title_is_rejected_rather_than_guessed():
    """cleanstart's title is a sentence, not a name. Without og/schema we must
    return nothing and let the LLM try, rather than store a sentence."""
    html = CLEANSTART.split("<script")[0] + "</head><body></body></html>"
    html = html.replace('<meta property="og:site_name" content="CleanStart">', "")
    assert extract_from_markup(html, "cleanstart.com") is None


@pytest.mark.parametrize("junk_title", ["Home", "Welcome", "Index", "Untitled", "   ", "404"])
def test_generic_titles_are_rejected(junk_title):
    html = f"<html><head><title>{junk_title}</title></head></html>"
    assert extract_from_markup(html, "x.com") is None


def test_nothing_usable_returns_none():
    assert extract_from_markup(BARE, "bare.com") is None
    assert extract_from_markup("", "x.com") is None
    assert extract_from_markup(None, "x.com") is None


def test_relative_logo_is_absolutised():
    html = (
        '<html><head><meta property="og:site_name" content="Acme">'
        '<meta property="og:image" content="/static/logo.png"></head></html>'
    )
    assert extract_from_markup(html, "acme.com")["logo_url"] == "https://acme.com/static/logo.png"


def test_schema_org_inside_a_graph_is_found():
    """Many CMSs emit @graph rather than a bare Organization node."""
    html = """<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Some Site"},
      {"@type":"Organization","name":"Graph Corp"}]}
    </script></head></html>"""
    assert extract_from_markup(html, "graph.com")["name"] == "Graph Corp"


def test_malformed_json_ld_does_not_raise():
    html = (
        '<html><head><script type="application/ld+json">{not json</script>'
        '<meta property="og:site_name" content="Fallback Co"></head></html>'
    )
    assert extract_from_markup(html, "x.com")["name"] == "Fallback Co"


# ── Defects found in adversarial review, 2026-08-10 ─────────────────────────


@pytest.mark.parametrize(
    "name_value",
    [
        '{"@value":"Acme","@language":"en"}',  # multilingual JSON-LD
        '["Acme","ACME Inc"]',  # array form
        "123",  # number
        "true",  # bool
        "null",
    ],
)
def test_non_string_json_ld_name_does_not_raise(name_value):
    """JSON-LD legitimately allows objects and arrays for `name`. The contract
    is 'never raises' — a bad type must fall through to og:site_name."""
    html = (
        '<html><head><script type="application/ld+json">'
        f'{{"@type":"Organization","name":{name_value}}}</script>'
        '<meta property="og:site_name" content="Real Co"></head></html>'
    )
    assert extract_from_markup(html, "x.com")["name"] == "Real Co"


@pytest.mark.parametrize(
    "title",
    [
        "Attention Required! | Cloudflare",
        "Just a moment...",
        "Coming Soon",
        "Under Construction",
        "Account Suspended",
        "403 Forbidden",
        "Welcome to nginx!",
        "Domain Default page",
        "Buy Domain | Sedo",
        "This site is temporarily unavailable",
        "Are you a robot?",
        "Site Maintenance",
    ],
)
def test_interstitial_and_parked_pages_are_not_companies(title):
    """The design requires a parked/blocked domain to be CACHED AS A FAILURE.
    Returning a name here short-circuits that path and would attribute every
    Cloudflare-challenged lead domain on the platform to 'Cloudflare'."""
    html = f"<html><head><title>{title}</title></head></html>"
    assert extract_from_markup(html, "x.com") is None


@pytest.mark.parametrize(
    "title",
    [
        "Acme Digital | Digital Marketing Agency | Mumbai",
        "Acme Solutions Pvt Ltd | SEO Agency | Delhi NCR",
        "Salesforce | The Customer Company | CRM",
    ],
)
def test_three_segment_titles_do_not_return_a_city_or_category(title):
    """'Brand | Category | City' is the standard title for this platform's
    core market. The shortest segment is the CITY, not the company."""
    result = extract_from_markup(f"<html><head><title>{title}</title></head></html>", "acme.com")
    assert result is None or result["name"].lower().startswith("acme") or "salesforce" in result["name"].lower()


@pytest.mark.parametrize(
    "nav",
    ["Contact Us", "About Us", "Login", "Blog", "Careers", "Pricing", "Privacy Policy"],
)
def test_nav_labels_are_never_the_company(nav):
    html = f"<html><head><title>{nav} | Acme Global Solutions Pvt Ltd</title></head></html>"
    result = extract_from_markup(html, "acme.com")
    assert result is None or result["name"] != nav


def test_third_party_organization_does_not_outrank_the_sites_own_og():
    """An article's `author` Organization is the publisher of the CONTENT, not
    the owner of the site."""
    html = (
        '<html><head><script type="application/ld+json">'
        '{"@type":"NewsArticle","author":{"@type":"Organization","name":"Reuters"}}'
        '</script><meta property="og:site_name" content="Acme Media"></head></html>'
    )
    assert extract_from_markup(html, "acmemedia.com")["name"] == "Acme Media"


def test_markup_containing_tags_is_rejected():
    """html.parser treats an unclosed <title> as RCDATA to EOF, swallowing
    real markup into the 'name'."""
    html = '<html><head><title>Acme<meta property="og:site_name" content="Acme Ltd"></head></html>'
    result = extract_from_markup(html, "acme.com")
    assert result is None or "<" not in result["name"]


def test_description_is_bounded():
    html = (
        '<html><head><meta property="og:site_name" content="Acme">'
        f'<meta property="og:description" content="{"x" * 5000}"></head></html>'
    )
    result = extract_from_markup(html, "acme.com")
    assert result["description"] is None or len(result["description"]) <= 500


def test_schema_org_subtypes_are_recognised():
    """LocalBusiness is extremely common on SMB sites."""
    for subtype in ("Corporation", "LocalBusiness", "OnlineStore", "https://schema.org/Organization"):
        html = (
            '<html><head><script type="application/ld+json">'
            f'{{"@type":"{subtype}","name":"Sub Corp"}}</script></head></html>'
        )
        assert extract_from_markup(html, "x.com")["name"] == "Sub Corp", subtype


def test_html_entities_are_decoded():
    html = (
        '<html><head><script type="application/ld+json">'
        '{"@type":"Organization","name":"Ben &amp; Jerry&#39;s"}</script></head></html>'
    )
    assert extract_from_markup(html, "x.com")["name"] == "Ben & Jerry's"


def test_deeply_nested_json_ld_does_not_raise():
    payload = "{" + '"a":{' * 3000 + '"b":1' + "}" * 3000 + "}"
    html = (
        f'<html><head><script type="application/ld+json">{payload}</script>'
        '<meta property="og:site_name" content="Deep Co"></head></html>'
    )
    assert extract_from_markup(html, "x.com")["name"] == "Deep Co"


def test_name_length_cap_is_enforced():
    """_MAX_NAME_LEN could previously be raised to any value without a single
    test noticing."""
    long_name = "A" * 200
    html = f'<html><head><meta property="og:site_name" content="{long_name}"></head></html>'
    assert extract_from_markup(html, "x.com") is None


def test_json_ld_walker_depth_guard_bites():
    """The existing nesting test passes because json.loads itself raises before
    the walker is reached. This exercises the walker's OWN guard via a deep
    @graph chain, which parses fine."""
    node = '{"@type":"Organization","name":"Too Deep"}'
    for _ in range(60):
        node = '{"@graph":' + node + "}"
    html = (
        f'<html><head><script type="application/ld+json">{node}</script>'
        '<meta property="og:site_name" content="Shallow Co"></head></html>'
    )
    # The deep Organization is beyond the depth cap, so og:site_name wins.
    assert extract_from_markup(html, "x.com")["name"] == "Shallow Co"


@pytest.mark.parametrize(
    "real_company",
    [
        "Apache Corporation",
        "Sparked",
        "Sedona Systems",
        "Trial and Error Films",
        "Forbidden Planet",
        "GoDaddy",
        "Namecheap",
    ],
)
def test_real_companies_are_not_caught_by_the_interstitial_blocklist(real_company):
    """Unanchored substring matching rejected these: 'Sparked' contains
    'parked', 'Sedona' contains 'sedo', 'Apache Corporation' is a Fortune 500
    oil company, not a web server."""
    html = f'<html><head><meta property="og:site_name" content="{real_company}"></head></html>'
    result = extract_from_markup(html, "x.com")
    assert result is not None and result["name"] == real_company


def test_logo_url_is_bounded():
    html = (
        '<html><head><meta property="og:site_name" content="Acme">'
        f'<meta property="og:image" content="https://cdn.example/{"a" * 900}.png"></head></html>'
    )
    assert extract_from_markup(html, "acme.com")["logo_url"] is None


# ── extract_logo ─────────────────────────────────────────────────────────────
#
# Added with the resolver's LLM path, which uses it to recover a logo from a
# page that declared no NAME. It shares parsing with extract_from_markup
# precisely because the hand-rolled regex it replaced mishandled attribute
# order, `name=` vs `property=`, and HTML entities — the last of which wrote a
# broken URL into a cache every tenant renders.


def test_extract_logo_absolutises_a_relative_og_image():
    html = '<html><head><meta property="og:image" content="/img/logo.png"></head></html>'
    assert extract_logo(html, "acme.com") == "https://acme.com/img/logo.png"


def test_extract_logo_decodes_html_entities():
    """`&amp;` reaching a browser as a literal `&amp;` is a broken image."""
    html = '<html><head><meta property="og:image" content="/a&amp;b.png"></head></html>'
    assert extract_logo(html, "acme.com") == "https://acme.com/a&b.png"


def test_extract_logo_accepts_the_name_attribute_spelling():
    """Plenty of real sites write `name=` rather than `property=`."""
    html = '<html><head><meta name="og:image" content="https://cdn.acme.com/l.png"></head></html>'
    assert extract_logo(html, "acme.com") == "https://cdn.acme.com/l.png"


def test_extract_logo_is_indifferent_to_attribute_order():
    html = '<html><head><meta content="https://cdn.acme.com/l.png" property="og:image"></head></html>'
    assert extract_logo(html, "acme.com") == "https://cdn.acme.com/l.png"


@pytest.mark.parametrize(
    "html",
    [
        "",
        None,
        "<html><head></head></html>",
        '<html><head><meta property="og:image" content=""></head></html>',
        '<html><head><meta property="og:image" content="javascript:alert(1)"></head></html>',
        '<html><head><meta property="og:image" content="data:image/png;base64,AAAA"></head></html>',
    ],
)
def test_extract_logo_returns_none_rather_than_a_junk_url(html):
    assert extract_logo(html, "acme.com") is None
