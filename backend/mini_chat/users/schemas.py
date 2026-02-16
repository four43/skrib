from pydantic import BaseModel
from typing import List, Optional, Literal


class UserPreferences(BaseModel):
    color: str
    theme_color: Optional[str] = None
    nickname: Optional[str] = None


class GetPreferencesResponse(BaseModel):
    username: str
    color: str
    theme_color: Optional[str] = None
    theme_name: Optional[str] = None
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


class UpdatePendingUserRequest(BaseModel):
    """Request body for updating pending user status via PATCH."""
    status: Literal['approved', 'rejected']


class ApproveUserRequest(BaseModel):
    approval_code: str


class RejectUserRequest(BaseModel):
    approval_code: str


class UserInfo(BaseModel):
    username: str
    role: str
    status: str
    approved_at: str | None
    approved_by: str | None
    approval_code: Optional[str] = None  # For pending users
    created_at: Optional[str] = None  # Registration timestamp


class UserProfile(BaseModel):
    """Full user profile including preferences."""
    username: str
    role: str
    status: str
    color: str
    theme_color: Optional[str] = None
    theme_name: Optional[str] = None
    nickname: Optional[str] = None


class UserUpdateRequest(BaseModel):
    """Request body for updating user properties via PATCH."""
    color: Optional[str] = None
    theme_color: Optional[str] = None
    theme_name: Optional[str] = None
    nickname: Optional[str] = None
    role: Optional[str] = None  # Admin only


class UsersListResponse(BaseModel):
    users: List[UserInfo]


# Legacy schemas - deprecated
class SetRoleRequest(BaseModel):
    """Deprecated: use UserUpdateRequest with PATCH instead."""
    username: str
    role: str
