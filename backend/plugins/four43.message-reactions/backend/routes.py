"""REST API endpoints for reactions plugin."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from skrib.plugins.auth import plugin_user

from . import database as db

router = APIRouter(prefix="/reactions", tags=["Plugin: four43/message-reactions"])


class AddReactionRequest(BaseModel):
    message_id: int
    room_id: str
    emoji: str


class RemoveReactionRequest(BaseModel):
    message_id: int
    emoji: str


@router.post("/add")
async def add_reaction(
    request: AddReactionRequest,
    username: str = Depends(plugin_user)
):
    """Add a reaction to a message."""
    success = db.add_reaction(request.message_id, username, request.emoji, request.room_id)
    if not success:
        raise HTTPException(status_code=400, detail="Reaction already exists")

    return {
        "message_id": request.message_id,
        "emoji": request.emoji,
        "username": username
    }


@router.post("/remove")
async def remove_reaction(
    request: RemoveReactionRequest,
    username: str = Depends(plugin_user)
):
    """Remove a reaction from a message."""
    db.remove_reaction(request.message_id, username, request.emoji)
    return {}


@router.get("/message/{message_id}")
async def get_message_reactions(message_id: int):
    """Get all reactions for a specific message."""
    return db.get_reactions(message_id)


@router.get("/room/{room_id}")
async def get_room_reactions(
    room_id: str,
    min_id: int = Query(..., description="Minimum message ID (inclusive)"),
    max_id: int = Query(..., description="Maximum message ID (inclusive)"),
):
    """Get reactions for all messages in a room within an ID range."""
    return db.get_reactions_for_room_range(room_id, min_id, max_id)
