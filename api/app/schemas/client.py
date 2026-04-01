from pydantic import BaseModel, Field, field_validator


class ClientSettingsUpdate(BaseModel):
    bot_name: str | None = None
    bot_logo: str | None = None
    launcher_name: str | None = None
    launcher_logo: str | None = None
    primary_color: str | None = None
    background_color: str | None = None
    header_color: str | None = None


class CrawlRequest(BaseModel):
    url: str
    max_pages: int | None = Field(default=None, ge=1, le=100)

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL must not be empty")
        if not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v
