"""API endpoints for theme management."""
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

router = APIRouter(prefix="/themes", tags=["themes"])

# Directory for distributed themes (zip-based bundles)
THEMES_DIR = Path(__file__).parent.parent.parent / "themes"


class ThemeVariant(BaseModel):
    """Theme variant information."""
    id: str
    name: str
    default: bool = False


class ThemeAssets(BaseModel):
    """Theme asset references."""
    css: List[str]
    images: Optional[Dict[str, str]] = None


class ThemeCustomization(BaseModel):
    """Theme customization options."""
    colors: Optional[Dict[str, Any]] = None
    fonts: Optional[Dict[str, Any]] = None


class ThemeInfo(BaseModel):
    """Theme manifest information."""
    id: str
    name: str
    version: str
    description: str
    author: str
    type: str
    variants: List[ThemeVariant]
    assets: ThemeAssets
    customization: Optional[ThemeCustomization] = None


def get_theme_dir(theme_id: str) -> Path:
    """Get the directory path for a theme."""
    theme_path = THEMES_DIR / theme_id
    if not theme_path.exists() or not theme_path.is_dir():
        raise HTTPException(status_code=404, detail=f"Theme {theme_id} not found")
    return theme_path


def load_theme_manifest(theme_id: str) -> ThemeInfo:
    """Load and parse a theme's manifest.json."""
    theme_dir = get_theme_dir(theme_id)
    manifest_path = theme_dir / "manifest.json"

    if not manifest_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Manifest not found for theme {theme_id}"
        )

    try:
        with open(manifest_path, 'r') as f:
            manifest_data = json.load(f)
        return ThemeInfo(**manifest_data)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load manifest for {theme_id}: {str(e)}"
        )


@router.get("/", response_model=List[ThemeInfo])
async def list_themes():
    """List all available themes.

    Returns:
        List[ThemeInfo]: List of theme manifests
    """
    if not THEMES_DIR.exists():
        return []

    themes = []
    for theme_dir in THEMES_DIR.iterdir():
        if theme_dir.is_dir() and (theme_dir / "manifest.json").exists():
            try:
                theme_info = load_theme_manifest(theme_dir.name)
                themes.append(theme_info)
            except Exception as e:
                print(f"[Themes] Failed to load theme {theme_dir.name}: {e}")
                continue

    return themes


@router.get("/{theme_id}/manifest")
async def get_theme_manifest(theme_id: str):
    """Get a theme's manifest.

    Args:
        theme_id: ID of the theme (e.g., 'com.four43.theme-default')

    Returns:
        ThemeInfo: Theme manifest data
    """
    return load_theme_manifest(theme_id)


@router.get("/{theme_id}/file/{file_path:path}")
async def get_theme_file(theme_id: str, file_path: str):
    """
    Serve a theme file (CSS, images, etc.).

    Args:
        theme_id: ID of the theme (e.g., 'com.four43.theme-default')
        file_path: Path to file relative to theme directory

    Returns:
        FileResponse: The requested file

    Security:
        Only files within the theme directory are allowed.
        Path traversal is prevented.
    """
    theme_dir = get_theme_dir(theme_id)

    # Resolve the requested file path and ensure it's within the theme directory
    requested_file = (theme_dir / file_path).resolve()

    # Security check: ensure the resolved path is within the theme directory
    try:
        requested_file.relative_to(theme_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Access denied: path traversal not allowed"
        )

    # Check if file exists
    if not requested_file.exists() or not requested_file.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"File {file_path} not found in theme {theme_id}"
        )

    # Determine content type based on extension
    content_type = "application/octet-stream"
    ext = requested_file.suffix.lower()
    if ext == ".css":
        content_type = "text/css"
    elif ext == ".js":
        content_type = "application/javascript"
    elif ext == ".json":
        content_type = "application/json"
    elif ext in [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif"]:
        content_type = f"image/{ext[1:]}"
        if ext == ".svg":
            content_type = "image/svg+xml"
    elif ext == ".ico":
        content_type = "image/x-icon"
    elif ext == ".woff":
        content_type = "font/woff"
    elif ext == ".woff2":
        content_type = "font/woff2"
    elif ext == ".ttf":
        content_type = "font/ttf"

    return FileResponse(
        requested_file,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=86400",  # Cache for 24 hours
        }
    )


@router.get("/{theme_id}")
async def get_theme_css(theme_id: str):
    """
    Convenience endpoint to get combined theme CSS.

    Args:
        theme_id: ID of the theme (e.g., 'com.four43.theme-default')

    Returns:
        Combined CSS from all files listed in the theme's manifest
    """
    try:
        manifest = load_theme_manifest(theme_id)
        theme_dir = get_theme_dir(theme_id)

        # Combine all CSS files
        combined_css = []
        for css_file in manifest.assets.css:
            css_path = theme_dir / css_file
            if css_path.exists():
                with open(css_path, 'r') as f:
                    combined_css.append(f"/* {css_file} */\n{f.read()}\n")

        from fastapi.responses import Response
        return Response(
            content="\n".join(combined_css),
            media_type="text/css",
            headers={
                "Cache-Control": "public, max-age=86400",
            }
        )
    except Exception as e:
        raise HTTPException(
            status_code=404,
            detail=f"Failed to load theme CSS: {str(e)}"
        )
