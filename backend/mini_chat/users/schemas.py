from pydantic import BaseModel
from typing import List, Optional


class UserPreferences(BaseModel):
    color: str
    theme_color: Optional[str] = None
    nickname: Optional[str] = None


class GetPreferencesResponse(BaseModel):
    username: str
    color: str
    theme_color: Optional[str] = None
    nickname: Optional[str] = None


class UpdatePreferencesRequest(BaseModel):
    color: Optional[str] = None
    theme_color: Optional[str] = None
    nickname: Optional[str] = None


class UpdatePreferencesResponse(BaseModel):
    status: str


class PendingUser(BaseModel):
    username: str
    approval_code: str
    registered_at: str


class PendingUsersResponse(BaseModel):
    pending: List[PendingUser]


class ApproveUserRequest(BaseModel):
    approval_code: str


class RejectUserRequest(BaseModel):
    approval_code: str


class UserInfo(BaseModel):
    username: str
    role: str
    approved: bool
    approved_at: str | None
    approved_by: str | None


class UsersListResponse(BaseModel):
    users: List[UserInfo]


class SetRoleRequest(BaseModel):
    username: str
    role: str
