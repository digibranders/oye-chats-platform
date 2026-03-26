from typing import Optional
from pydantic import BaseModel


class ClientSettingsUpdate(BaseModel):
    bot_name: Optional[str] = None
    bot_logo: Optional[str] = None
    launcher_name: Optional[str] = None
    launcher_logo: Optional[str] = None
    primary_color: Optional[str] = None
    background_color: Optional[str] = None
    header_color: Optional[str] = None


class CrawlRequest(BaseModel):
    url: str
