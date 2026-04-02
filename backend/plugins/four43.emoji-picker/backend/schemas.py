"""Pydantic models for emoji picker plugin."""
from pydantic import BaseModel


class CustomEmojiOut(BaseModel):
    shortcode: str
    display_name: str
    category: str
    url: str


class CustomEmojiUpdate(BaseModel):
    display_name: str | None = None
    category: str | None = None
