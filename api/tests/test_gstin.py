"""GSTIN format + checksum validation (15-char, Rule 46 buyer/seller identity).

Layout: SS PPPPPPPPPP E Z C. SS = state code (01-38 or 97), 10-char PAN,
E = entity code, literal 'Z', C = mod-36 check character.
"""

import pytest

from app.core.gstin import compute_check_char, is_valid_gstin


def test_known_valid_gstin():
    # Widely-published valid example (Maharashtra partnership firm).
    assert is_valid_gstin("27AAPFU0939F1ZV") is True


def test_lowercase_and_whitespace_normalized():
    assert is_valid_gstin("  27aapfu0939f1zv ") is True


def test_wrong_check_digit_rejected():
    assert is_valid_gstin("27AAPFU0939F1ZW") is False


@pytest.mark.parametrize(
    "bad",
    [
        "",  # empty
        "27AAPFU0939F1Z",  # 14 chars
        "27AAPFU0939F1ZVX",  # 16 chars
        "00AAPFU0939F1ZV",  # state 00 invalid
        "99AAPFU0939F1ZV",  # state 99 invalid (97 is the only >38 code)
        "27AAPFU0939F1YV",  # 14th char must be literal 'Z'
        "271APFU0939F1ZV",  # PAN must start with 5 letters
    ],
)
def test_structurally_invalid_rejected(bad):
    assert is_valid_gstin(bad) is False


def test_compute_check_char_roundtrip():
    body = "27AAPFU0939F1Z"
    assert body + compute_check_char(body) == "27AAPFU0939F1ZV"
