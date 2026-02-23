"""HTTP routes for todo list operations."""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional

from skrib.dependencies import require_auth
from skrib.permissions import check_room_membership as _check_room_access, require_edit_permission as _check_edit_permission

# Injected by plugin.py after module load
TodoList = None

router = APIRouter(tags=["Plugin: four43/room-type-todo"])


# --- Schemas ---

class TodoItemResponse(BaseModel):
    id: int
    room_id: str
    username: str
    title: str
    description: str
    done: bool
    created_at: str
    updated_at: str


class CreateTodoRequest(BaseModel):
    title: str
    description: str = ''


class UpdateTodoRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    done: Optional[bool] = None


# --- Endpoints ---

@router.get("/rooms/{room_id}/items", response_model=list[TodoItemResponse])
async def get_todo_items(
    room_id: str,
    username: str = Depends(require_auth),
):
    """Get all todo items for a room."""
    _check_room_access(room_id, username)
    todo = TodoList(room_id)
    return todo.get_items()


@router.post("/rooms/{room_id}/items", response_model=TodoItemResponse, status_code=201)
async def create_todo_item(
    room_id: str,
    request: CreateTodoRequest,
    username: str = Depends(require_auth),
):
    """Create a new todo item."""
    _check_room_access(room_id, username)

    if not request.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")

    todo = TodoList(room_id)
    item = todo.add_item(username, request.title.strip(), request.description.strip())
    return item


@router.patch("/rooms/{room_id}/items/{item_id}", response_model=TodoItemResponse)
async def update_todo_item(
    room_id: str,
    item_id: int,
    request: UpdateTodoRequest,
    username: str = Depends(require_auth),
):
    """Update a todo item. Any member can toggle done. Only creator/ops/admins can edit title/description."""
    _check_room_access(room_id, username)

    todo = TodoList(room_id)
    item = todo.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # If updating title or description, check edit permission
    if request.title is not None or request.description is not None:
        _check_edit_permission(room_id, username, item['username'])

    updated = todo.update_item(
        item_id,
        title=request.title,
        description=request.description,
        done=request.done,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="Item not found")

    return updated


@router.delete("/rooms/{room_id}/items/{item_id}")
async def delete_todo_item(
    room_id: str,
    item_id: int,
    username: str = Depends(require_auth),
):
    """Delete a todo item. Only creator/ops/admins can delete."""
    _check_room_access(room_id, username)

    todo = TodoList(room_id)
    item = todo.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    _check_edit_permission(room_id, username, item['username'])

    todo.delete_item(item_id)
    return {}
