"""Pydantic schemas for server info."""
from enum import Enum
from typing import Optional
from pydantic import BaseModel


class RegistrationMode(str, Enum):
    closed = "closed"
    invite_only = "invite_only"
    approval_required = "approval_required"
    open = "open"


class ServerInfoResponse(BaseModel):
    registration_mode: RegistrationMode
    default_theme: str
    name: str
    icon_custom: bool = False


class ServerUpdateRequest(BaseModel):
    """Request body for updating server properties via PATCH."""
    registration_mode: Optional[RegistrationMode] = None
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


class CreateInviteResponse(BaseModel):
    token: str
    invite_url: str


class RegistrationStatusResponse(BaseModel):
    mode: RegistrationMode


