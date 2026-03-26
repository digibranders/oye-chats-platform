from pydantic import BaseModel


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
