"""Pydantic schemas for rooms."""
from pydantic import BaseModel
from typing import List, Literal, Optional


class RoomInfo(BaseModel):
    room_id: str
    room_type: str  # "chat"
    display_name: str  # "#general" or "alice"
    topic: str = ''
    visibility: str = 'private'
    members: List[str] = []
    unread_count: int = 0
    notify_level: str = 'all'  # "all", "mentions", "muted"
    is_dm: bool = False
    folder_id: Optional[str] = None
    sort_position: float = 0


class CreateRoomRequest(BaseModel):
    room_id: str
    room_type: str = 'chat'
    visibility: Literal['private', 'public'] = 'private'


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
    visibility: str = 'private'
    created_by: str | None
    members: List[MemberInfo]
    is_dm: bool = False


class RoomUpdateRequest(BaseModel):
    """Request body for updating room properties via PATCH."""
    topic: Optional[str] = None
    visibility: Optional[Literal['private', 'public']] = None
    folder_id: Optional[str] = None
    sort_position: Optional[float] = None


class MemberUpdateRequest(BaseModel):
    """Request body for updating member properties via PATCH."""
    notify_level: Optional[Literal['all', 'mentions', 'muted']] = None
    room_role: Optional[Literal['op', 'voice', 'member']] = None


class RoomSearchResult(BaseModel):
    room_id: str
    room_type: str
    topic: str
    visibility: str
    member_count: int


class JoinRequestInfo(BaseModel):
    room_id: str
    username: str
    status: str
    created_at: str
    nickname: Optional[str] = None
    color: Optional[str] = None


class JoinRequestAction(BaseModel):
    action: Literal['approve', 'deny']

