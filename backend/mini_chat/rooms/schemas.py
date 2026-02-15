"""Pydantic schemas for rooms."""
from pydantic import BaseModel
from typing import List, Optional


class RoomInfo(BaseModel):
    room_id: str
    room_type: str  # "channel" or "dm"
    display_name: str  # "#general" or "alice"
    members: List[str] = []
    unread_count: int = 0


class RoomListResponse(BaseModel):
    rooms: List[RoomInfo]


class CreateRoomRequest(BaseModel):
    room_id: str


class CreateRoomResponse(BaseModel):
    status: str
    room_id: str


class CreateDMRequest(BaseModel):
    usernames: List[str]


class CreateDMResponse(BaseModel):
    status: str
    room: RoomInfo


class MessageResponse(BaseModel):
    id: int
    username: str
    message: str
    timestamp: str


class SendMessageRequest(BaseModel):
    message: str


class SendMessageResponse(BaseModel):
    status: str
    message: MessageResponse


class MessagesResponse(BaseModel):
    status: str
    messages: List[MessageResponse]


class DeleteRoomResponse(BaseModel):
    status: str
    room_id: str


class AddMemberRequest(BaseModel):
    username: str


class AddMemberResponse(BaseModel):
    status: str
    room_id: str
    username: str


class RemoveMemberResponse(BaseModel):
    status: str
    room_id: str
    username: str


class StoreRoomKeyRequest(BaseModel):
    username: str
    encrypted_key: str
    key_epoch: int = 0


class RoomKeyEntry(BaseModel):
    key_epoch: int
    encrypted_key: str


class RoomKeysResponse(BaseModel):
    keys: List[RoomKeyEntry]


class MarkReadRequest(BaseModel):
    last_read_message_id: int
