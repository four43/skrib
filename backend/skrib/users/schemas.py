from pydantic import BaseModel
from typing import List, Optional, Literal


class UserStatus(BaseModel):
    emoji: Optional[str] = None
    text: Optional[str] = None


class UserApproval(BaseModel):
    code: Optional[str] = None
    time: Optional[str] = None
    by: Optional[str] = None


class UserPreferences(BaseModel):
    color: str
    nickname: Optional[str] = None


class GetPreferencesResponse(BaseModel):
    username: str
    color: str
    theme_name: Optional[str] = None
    color_scheme: Optional[str] = None
    nickname: Optional[str] = None


class UpdatePreferencesRequest(BaseModel):
    color: Optional[str] = None
    nickname: Optional[str] = None


class UpdatePreferencesResponse(BaseModel):
    pass


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


class UserDisplayInfo(BaseModel):
    """Default GET /users response — display metadata only."""
    username: str
    nickname: Optional[str] = None
    color: str
    status: UserStatus


class UserAdminInfo(UserDisplayInfo):
    """GET /users?detail=admin — includes admin-oriented fields."""
    role: str
    account_status: str
    approval: UserApproval
    created_at: Optional[str] = None


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
    color: str
    nickname: Optional[str] = None
    status: UserStatus
    # Private fields — only included when viewing own profile
    theme_name: Optional[str] = None
    color_scheme: Optional[str] = None


class UserUpdateRequest(BaseModel):
    """Request body for updating user properties via PATCH."""
    color: Optional[str] = None
    theme_name: Optional[str] = None
    color_scheme: Optional[str] = None
    nickname: Optional[str] = None
    status_emoji: Optional[str] = None
    status_text: Optional[str] = None
    role: Optional[str] = None  # Admin only


# Legacy schemas - deprecated
class SetRoleRequest(BaseModel):
    """Deprecated: use UserUpdateRequest with PATCH instead."""
    username: str
    role: str
