"""REST API endpoints for reactions plugin."""
import sys
import importlib.util
from pathlib import Path

# Add parent directory to path to import mini_chat
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from mini_chat.dependencies import require_auth

# Load database module
_db_spec = importlib.util.spec_from_file_location("db", Path(__file__).parent / "database.py")
db = importlib.util.module_from_spec(_db_spec)
_db_spec.loader.exec_module(db)

router = APIRouter(prefix="/reactions", tags=["reactions"])


class AddReactionRequest(BaseModel):
    message_id: int
    emoji: str


class RemoveReactionRequest(BaseModel):
    message_id: int
    emoji: str


@router.post("/add")
async def add_reaction(
    request: AddReactionRequest,
    username: str = Depends(require_auth)
):
    """Add a reaction to a message.

    Args:
        request: Contains message_id and emoji
        username: Authenticated user (from token)

    Returns:
        Reaction details
    """
    success = db.add_reaction(request.message_id, username, request.emoji)
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
    username: str = Depends(require_auth)
):
    """Remove a reaction from a message.

    Args:
        request: Contains message_id and emoji
        username: Authenticated user (from token)

    Returns:
        Success status
    """
    db.remove_reaction(request.message_id, username, request.emoji)
    return {"success": True}


@router.get("/message/{message_id}")
async def get_message_reactions(message_id: int):
    """Get all reactions for a specific message.

    Args:
        message_id: ID of the message

    Returns:
        List of reactions grouped by emoji
    """
    return db.get_reactions(message_id)


@router.get("/messages")
async def get_multiple_reactions(message_ids: str):
    """Get reactions for multiple messages.

    Args:
        message_ids: Comma-separated list of message IDs (e.g., "123,124,125")

    Returns:
        Dictionary mapping message IDs to their reactions
    """
    try:
        ids = [int(id.strip()) for id in message_ids.split(',') if id.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid message IDs format")

    return db.get_reactions_for_messages(ids)
