"""Pydantic schemas for rooms."""
from pydantic import BaseModel
from typing import List, Literal, Optional


class RoomInfo(BaseModel):
    room_id: str
    room_type: str  # "channel" or "dm"
    display_name: str  # "#general" or "alice"
    topic: str = ''
    members: List[str] = []
    unread_count: int = 0
    notify_level: str = 'all'  # "all", "mentions", "muted"


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
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None
    timestamp: str


class SendMessageRequest(BaseModel):
    content: str
    content_type: str = 'text'
    key_epoch: Optional[int] = None


class SendMessageResponse(BaseModel):
    status: str
    message: MessageResponse


class MessagesResponse(BaseModel):
    status: str
    messages: List[MessageResponse]


class DeleteRoomResponse(BaseModel):
    status: str
    room_id: str


class InviteRequest(BaseModel):
    """Request body for inviting a member to a room."""
    username: str


# Legacy schemas - kept for backwards compatibility, can be removed later
class AddMemberRequest(BaseModel):
    """Deprecated: use InviteRequest instead."""
    username: str


class AddMemberResponse(BaseModel):
    """Deprecated: endpoints now return plain dicts."""
    status: str
    room_id: str
    username: str


class RemoveMemberResponse(BaseModel):
    """Deprecated: endpoints now return plain dicts."""
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


class UpdateNotifyLevelRequest(BaseModel):
    notify_level: Literal['all', 'mentions', 'muted']


class MemberInfo(BaseModel):
    username: str
    room_role: str
    joined_at: str | None


class RoomDetailResponse(BaseModel):
    room_id: str
    room_type: str
    topic: str
    created_by: str | None
    members: List[MemberInfo]


class SetTopicRequest(BaseModel):
    topic: str


class SetRoomRoleRequest(BaseModel):
    username: str
    role: Literal['op', 'voice', 'member']
