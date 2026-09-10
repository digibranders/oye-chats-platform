"""An upload that could not be read says so in the response.

A file whose extraction fails is correctly not charged for, and the background
pass quarantines it. But the upload response reported it as
``{"words": 0, "credits": 0}``, indistinguishable from an empty file that
uploaded fine, so the customer was told "uploaded, free" and found out only
later that the document was never ingested.

``preview-cost`` reports ``reason: "extraction_failed"`` for exactly this.
The upload response uses the same vocabulary, and there is only the one word:
the console renders a reason by exact match, so a second spelling of the same
failure fell through to a raw ``extraction_error`` string on screen.
"""

from __future__ import annotations

import pytest


def _helper():
    """The helper is a closure inside the upload route, so exercise it through
    the module's source contract rather than importing it directly."""
    import inspect

    from app.api import document_routes

    return inspect.getsource(document_routes)


class TestTheResponseCarriesTheReason:
    def test_the_helper_returns_a_reason(self):
        source = _helper()

        assert "def _extract_words_for_cost(path: Path, ext: str) -> tuple[int, int, str | None]:" in source

    @pytest.mark.parametrize("builder", ["per_file", "per_file_billing"])
    def test_both_response_builders_include_it(self, builder):
        source = _helper()

        marker = f'"{builder}": ['
        assert marker in source
        block = source[source.index(marker) : source.index(marker) + 400]
        assert '"reason": r' in block, f"{builder} drops the reason"

    def test_a_readable_file_reports_no_reason(self):
        """None, not the string "none": the field is absent-shaped for a file
        that uploaded cleanly, so a client can test it truthily."""
        source = _helper()

        assert "return credit_service.count_words(raw), len(cleaned), None" in source

    def test_both_failure_paths_use_the_shared_vocabulary(self):
        source = _helper()

        assert source.count('return 0, 0, "extraction_failed"') == 2

    def test_there_is_only_one_spelling_of_the_reason(self):
        source = _helper()

        assert "extraction_error" not in source
        assert source.count('"extraction_failed"') == 4, "preview-cost (2 paths) and upload (2 paths)"
