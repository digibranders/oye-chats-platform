import bcrypt


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against the hashed version. Truncates to 72 bytes for bcrypt."""
    pwd_bytes = plain_password.encode("utf-8")[:72]
    hashed_bytes = hashed_password.encode("utf-8")
    return bcrypt.checkpw(pwd_bytes, hashed_bytes)


def get_password_hash(password: str) -> str:
    """Hashes a password for storage. Truncates to 72 bytes for bcrypt."""
    pwd_bytes = password.encode("utf-8")[:72]
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(pwd_bytes, salt)
    return hashed_bytes.decode("utf-8")
