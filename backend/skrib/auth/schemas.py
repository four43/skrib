"""Pydantic schemas for authentication."""
from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class Role(str, Enum):
    ADMIN = "admin"
    USER = "user"


class RPInfo(BaseModel):
    name: str
    id: str


class AllowCredential(BaseModel):
    type: str
    id: str


class RegistrationBeginResponse(BaseModel):
    challenge: str
    rp: RPInfo


class RegistrationCompleteRequest(BaseModel):
    username: str
    credentialId: str
    publicKey: str
    challenge: str
    invite_token: Optional[str] = None


class RegistrationCompleteResponse(BaseModel):
    status: str
    approval_code: str


class LoginBeginResponse(BaseModel):
    challenge: str
    rpId: str
    allowCredentials: List[AllowCredential]


class LoginCompleteRequest(BaseModel):
    credentialId: str
    challenge: str


class LoginCompleteResponse(BaseModel):
    status: str
    session_token: str
    username: str
    role: str


class SessionResponse(BaseModel):
    authenticated: bool
    username: Optional[str] = None
    role: Optional[str] = None


class StoreEncryptionKeyRequest(BaseModel):
    public_key: str  # JWK JSON string


class EncryptionKeyResponse(BaseModel):
    username: str
    public_key: str
