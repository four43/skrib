"""HTTP routes for todo list operations."""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from typing import List, Optional

from skrib.plugins.auth import require_room_member, get_user_role, get_room_role, require_edit_permission

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
    request: Request,
    username: str = Depends(require_room_member),
):
    """Get all todo items for a room."""
    todo = TodoList(room_id)
    return todo.get_items()


@router.post("/rooms/{room_id}/items", response_model=TodoItemResponse, status_code=201)
async def create_todo_item(
    room_id: str,
    body: CreateTodoRequest,
    request: Request,
    username: str = Depends(require_room_member),
):
    """Create a new todo item."""
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")

    todo = TodoList(room_id)
    item = todo.add_item(username, body.title.strip(), body.description.strip())
    return item


@router.patch("/rooms/{room_id}/items/{item_id}", response_model=TodoItemResponse)
async def update_todo_item(
    room_id: str,
    item_id: int,
    body: UpdateTodoRequest,
    request: Request,
    username: str = Depends(require_room_member),
):
    """Update a todo item. Any member can toggle done. Only creator/ops/admins can edit title/description."""
    todo = TodoList(room_id)
    item = todo.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # If updating title or description, check edit permission
    if body.title is not None or body.description is not None:
        require_edit_permission(
            username, item['username'],
            room_role=get_room_role(request),
            global_role=get_user_role(request),
        )

    updated = todo.update_item(
        item_id,
        title=body.title,
        description=body.description,
        done=body.done,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="Item not found")

    return updated


@router.delete("/rooms/{room_id}/items/{item_id}")
async def delete_todo_item(
    room_id: str,
    item_id: int,
    request: Request,
    username: str = Depends(require_room_member),
):
    """Delete a todo item. Only creator/ops/admins can delete."""
    todo = TodoList(room_id)
    item = todo.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    require_edit_permission(
        username, item['username'],
        room_role=get_room_role(request),
        global_role=get_user_role(request),
    )

    todo.delete_item(item_id)
    return {}
