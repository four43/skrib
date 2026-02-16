"""Pydantic schemas for server info."""
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel


class RegistrationMode(str, Enum):
    closed = "closed"
    invite_only = "invite_only"
    approval_required = "approval_required"
    open = "open"


class ServerInfoResponse(BaseModel):
    registration_mode: RegistrationMode
    server_color: str
    default_theme: str
    name: str


class ServerUpdateRequest(BaseModel):
    """Request body for updating server properties via PATCH."""
    registration_mode: Optional[RegistrationMode] = None
    server_color: Optional[str] = None
    default_theme: Optional[str] = None
    name: Optional[str] = None


class UpdateRegistrationModeRequest(BaseModel):
    mode: RegistrationMode


class UpdateRegistrationModeResponse(BaseModel):
    mode: RegistrationMode


class InviteTokenResponse(BaseModel):
    token: str
    created_by: str
    created_at: str
    used_by: Optional[str] = None
    used_at: Optional[str] = None


class InviteTokenListResponse(BaseModel):
    invites: List[InviteTokenResponse]


class CreateInviteResponse(BaseModel):
    token: str
    invite_url: str


class RegistrationStatusResponse(BaseModel):
    mode: RegistrationMode


class ServerThemeResponse(BaseModel):
    server_color: str


class UpdateServerColorRequest(BaseModel):
    server_color: str


class UpdateServerColorResponse(BaseModel):
    server_color: str
