"""Tests for password hashing and verification."""
from app.core.security import get_password_hash, verify_password


class TestPasswordSecurity:
    def test_hash_and_verify(self):
        password = "MySecurePassword123"
        hashed = get_password_hash(password)
        assert verify_password(password, hashed) is True

    def test_wrong_password_fails(self):
        hashed = get_password_hash("CorrectPassword1")
        assert verify_password("WrongPassword1", hashed) is False

    def test_hash_is_not_plaintext(self):
        password = "TestPassword123"
        hashed = get_password_hash(password)
        assert hashed != password
        assert hashed.startswith("$2b$")

    def test_different_hashes_for_same_password(self):
        password = "SamePassword123"
        hash1 = get_password_hash(password)
        hash2 = get_password_hash(password)
        assert hash1 != hash2  # Different salts
        assert verify_password(password, hash1) is True
        assert verify_password(password, hash2) is True

    def test_long_password_truncation(self):
        # bcrypt truncates at 72 bytes
        long_password = "A" * 100
        hashed = get_password_hash(long_password)
        assert verify_password(long_password, hashed) is True
