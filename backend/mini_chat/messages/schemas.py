"""Pydantic schemas for messages."""
from pydantic import BaseModel
from typing import List, Optional


class Message(BaseModel):
    id: int
    room_id: str
    username: str
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None
    timestamp: str


class SearchMessagesResponse(BaseModel):
    status: str
    messages: List[Message]
    total: int
