"""Pydantic schemas for room folders."""
from pydantic import BaseModel, field_validator
from typing import List, Optional


class FolderInfo(BaseModel):
    folder_id: str
    name: str
    parent_folder_id: Optional[str] = None
    position: float = 0


class CreateFolderRequest(BaseModel):
    name: str
    parent_folder_id: Optional[str] = None

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        v = v.strip()
        if not v or len(v) > 50:
            raise ValueError('Folder name must be 1-50 characters')
        return v


class CreateFolderResponse(BaseModel):
    folder_id: str


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    parent_folder_id: Optional[str] = None
    position: Optional[float] = None

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if v is not None:
            v = v.strip()
            if not v or len(v) > 50:
                raise ValueError('Folder name must be 1-50 characters')
        return v


class MoveRoomRequest(BaseModel):
    folder_id: Optional[str] = None
    position: float = 0


class ReorderItem(BaseModel):
    folder_id: str
    parent_folder_id: Optional[str] = None
    position: float


class ReorderRoomItem(BaseModel):
    room_id: str
    folder_id: Optional[str] = None
    position: float


class ReorderRequest(BaseModel):
    folders: List[ReorderItem] = []
    rooms: List[ReorderRoomItem] = []


class RoomPosition(BaseModel):
    room_id: str
    folder_id: Optional[str] = None
    position: float


class FolderTreeResponse(BaseModel):
    folders: List[FolderInfo]
    room_positions: List[RoomPosition]
