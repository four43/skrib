"""Pydantic schemas for rooms."""
from pydantic import BaseModel
from typing import List, Literal, Optional


class RoomInfo(BaseModel):
    room_id: str
    room_type: str  # "chat"
    display_name: str  # "#general" or "alice"
    topic: str = ''
    members: List[str] = []
    unread_count: int = 0
    notify_level: str = 'all'  # "all", "mentions", "muted"
    is_dm: bool = False


class CreateRoomRequest(BaseModel):
    room_id: str
    room_type: str = 'chat'


class CreateRoomResponse(BaseModel):
    room_id: str


class CreateDMRequest(BaseModel):
    usernames: List[str]
    room_type: str = 'chat'


class CreateDMResponse(BaseModel):
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
    message: MessageResponse


class DeleteRoomResponse(BaseModel):
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
    room_id: str
    username: str


class RemoveMemberResponse(BaseModel):
    """Deprecated: endpoints now return plain dicts."""
    room_id: str
    username: str


class StoreRoomKeyRequest(BaseModel):
    username: str
    encrypted_key: str
    key_epoch: int = 0


class RoomKeyEntry(BaseModel):
    key_epoch: int
    encrypted_key: str


class MarkReadRequest(BaseModel):
    last_read_message_id: int


class UpdateNotifyLevelRequest(BaseModel):
    notify_level: Literal['all', 'mentions', 'muted']


class MemberInfo(BaseModel):
    username: str
    room_role: str
    joined_at: str | None
    nickname: str | None = None
    color: str | None = None


class RoomDetailResponse(BaseModel):
    room_id: str
    room_type: str
    topic: str
    created_by: str | None
    members: List[MemberInfo]
    is_dm: bool = False


class RoomUpdateRequest(BaseModel):
    """Request body for updating room properties via PATCH."""
    topic: Optional[str] = None


class MemberUpdateRequest(BaseModel):
    """Request body for updating member properties via PATCH."""
    notify_level: Optional[Literal['all', 'mentions', 'muted']] = None
    room_role: Optional[Literal['op', 'voice', 'member']] = None


# Legacy schemas - deprecated
class SetTopicRequest(BaseModel):
    """Deprecated: use RoomUpdateRequest with PATCH instead."""
    topic: str


class SetRoomRoleRequest(BaseModel):
    """Deprecated: use MemberUpdateRequest with PATCH instead."""
    username: str
    role: Literal['op', 'voice', 'member']
