"""The qualified-lead email renders the ACTIVE framework's dimensions.

It used to render the four BANT columns for every bot, so a MEDDIC or CHAMP
lead arrived with an empty qualification table.
"""

from unittest.mock import patch

from app.services import email_service


def _render(**kwargs) -> str:
    with patch.object(email_service, "send_email_async") as send:
        email_service.send_qualified_lead_email(
            "ops@example.com", "Acme Bot", {"bant_need": "CRM"}, {"name": "Priya", "email": "p@x.io"}, **kwargs
        )
    send.assert_called_once()
    args, _ = send.call_args
    return args[2]  # html_body


def test_framework_rows_replace_the_bant_table():
    html = _render(
        qualification=[("Metrics", "Cut churn 20%"), ("Champion", None), ("Decision criteria", None)],
        framework_label="MEDDIC",
    )
    assert "Qualification (MEDDIC)" in html
    assert "Metrics" in html and "Cut churn 20%" in html and "Champion" in html
    assert "Budget" not in html and "Timeline" not in html


def test_legacy_callers_still_get_the_bant_table():
    html = _render()
    assert "Qualification (BANT)" in html
    assert "Need" in html and "CRM" in html and "Budget" in html


def test_values_are_escaped():
    html = _render(qualification=[("Need", "<script>alert(1)</script>")], framework_label="BANT")
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
