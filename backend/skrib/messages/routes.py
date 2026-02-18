"""Messages API routes."""
from fastapi import APIRouter, Depends, Query
from typing import Optional

from .schemas import SearchMessagesResponse
from .services import search_messages
from ..dependencies import require_auth

router = APIRouter(prefix="/messages", tags=["messages"])


@router.get("", response_model=SearchMessagesResponse)
async def search_all_messages(
    query: Optional[str] = Query(None, description="Search text in messages"),
    room_id: Optional[str] = Query(None, description="Filter by room ID"),
    username: Optional[str] = Query(None, description="Filter by username"),
    limit: int = Query(100, ge=1, le=500, description="Number of results to return"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    _: str = Depends(require_auth)  # Require authentication
):
    """Search messages across all rooms with optional filters."""
    messages, total = search_messages(
        query=query,
        room_id=room_id,
        username=username,
        limit=limit,
        offset=offset
    )

    return SearchMessagesResponse(
        status="ok",
        messages=messages,
        total=total
    )
