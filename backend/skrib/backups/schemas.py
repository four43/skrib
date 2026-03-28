"""Pydantic schemas for backup endpoints."""
from typing import Optional
from pydantic import BaseModel


class BackupInfo(BaseModel):
    filename: str
    size: int
    created_at: str

class BackupListResponse(BaseModel):
    backups: list[BackupInfo]

class BackupTriggerResponse(BaseModel):
    status: str
    filename: str
    size: int
    duration_seconds: float

class BackupConfigResponse(BaseModel):
    enabled: bool
    directory: str
    schedule: str
    retention_policy: dict

class BackupConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    directory: Optional[str] = None
    schedule: Optional[str] = None
    retention_policy: Optional[dict] = None

class SystemLogEntry(BaseModel):
    id: int
    timestamp: str
    level: str
    category: str
    message: str
    details: Optional[str] = None
    username: Optional[str] = None

class SystemLogResponse(BaseModel):
    entries: list[SystemLogEntry]
    total: int
    page: int
    page_size: int
