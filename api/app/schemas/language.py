from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class LocaleInfo(BaseModel):
    """Metadata describing a single supported locale."""

    code: str = Field(..., description="Base language code, e.g. 'en', 'hi'")
    locale: str = Field(..., description="BCP-47 locale tag, e.g. 'en-IN', 'hi-IN'")
    name: str = Field(..., description="English display name, e.g. 'English (India)'")
    native_name: str = Field(..., description="Endonym / native name, e.g. 'English', 'हिन्दी'")
    direction: Literal["ltr", "rtl"] = Field(default="ltr", description="Text direction")
    enabled: bool = Field(default=True, description="Whether this locale is active")


class LanguageContext(BaseModel):
    """Resolved conversation language context for a visitor / session."""

    language: str = Field(..., description="Base language code, e.g. 'en', 'hi'")
    locale: str = Field(..., description="Resolved BCP-47 locale tag, e.g. 'en-IN', 'hi-IN'")
    source: str = Field(
        ...,
        description="Resolution source: explicit | site | html_lang | browser | persisted | message_detected | geo | default",
    )
    confidence: float = Field(default=1.0, ge=0.0, le=1.0, description="Confidence score between 0.0 and 1.0")
    direction: Literal["ltr", "rtl"] = Field(default="ltr", description="Text direction: 'ltr' or 'rtl'")
    locked: bool = Field(default=False, description="True if visitor explicitly selected language (locks re-detection)")
