"""Identicon avatar generation using Pillow."""
import colorsys
import hashlib
import io

from PIL import Image, ImageDraw

from ..database import get_db

# Avatar image size in pixels
AVATAR_SIZE = 128
# Grid is 5x5 with vertical symmetry (only need 3 columns)
GRID_SIZE = 5
# Padding around the grid as a fraction of avatar size
PADDING_FRACTION = 0.1


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Convert '#rrggbb' to (r, g, b)."""
    h = hex_color.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _make_variants(hex_color: str) -> list[tuple[int, int, int]]:
    """Create 3 tonal variants of a color: base, light, dark."""
    r, g, b = _hex_to_rgb(hex_color)
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)

    def hls_to_rgb8(h, l, s):
        r, g, b = colorsys.hls_to_rgb(h, l, s)
        return (int(r * 255), int(g * 255), int(b * 255))

    return [
        hls_to_rgb8(h, min(l * 1.15, 0.65), s),            # light
        hls_to_rgb8(h, l, s),                                # base
        hls_to_rgb8(h, max(l * 0.75, 0.25), min(s * 1.1, 1.0)),  # dark
    ]


def _lighten(rgb: tuple[int, int, int], factor: float = 0.88) -> tuple[int, int, int]:
    """Lighten a color by blending toward white."""
    return tuple(int(c + (255 - c) * factor) for c in rgb)


def generate_identicon(username: str, color: str) -> bytes:
    """Generate a deterministic identicon PNG for a username.

    Algorithm: SHA-256 hash the username, use 15 bits to fill a 5x5
    vertically-symmetric grid. Each filled cell gets one of 3 tonal
    variants of the user's color (picked from additional hash bits).
    Background is a light tint.

    Returns PNG image bytes.
    """
    digest = hashlib.sha256(username.encode('utf-8')).hexdigest()
    hash_int = int(digest[:8], 16)   # bits 0-31: grid pattern
    shade_int = int(digest[8:16], 16)  # bits 32-63: shade selection

    # Build 5x5 grid with vertical symmetry
    # Also track which shade variant each cell gets (0-2)
    grid = []
    shades = []
    for row in range(GRID_SIZE):
        row_cells = []
        row_shades = []
        for col in range(3):  # left half + center column
            bit_index = row * 3 + col
            filled = (hash_int >> bit_index) & 1
            shade = (shade_int >> (bit_index * 2)) % 3
            row_cells.append(filled)
            row_shades.append(shade)
        # Mirror: [a, b, c] -> [a, b, c, b, a]
        grid.append(row_cells + [row_cells[1], row_cells[0]])
        shades.append(row_shades + [row_shades[1], row_shades[0]])

    variants = _make_variants(color)
    bg = _lighten(variants[1])  # lighten the base variant

    padding = int(AVATAR_SIZE * PADDING_FRACTION)
    cell_size = (AVATAR_SIZE - 2 * padding) / GRID_SIZE

    img = Image.new('RGB', (AVATAR_SIZE, AVATAR_SIZE), bg)
    draw = ImageDraw.Draw(img)

    for row in range(GRID_SIZE):
        for col in range(GRID_SIZE):
            if grid[row][col]:
                x0 = padding + col * cell_size
                y0 = padding + row * cell_size
                x1 = x0 + cell_size
                y1 = y0 + cell_size
                draw.rectangle([x0, y0, x1, y1], fill=variants[shades[row][col]])

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def get_or_generate_avatar(username: str) -> bytes | None:
    """Get a user's avatar from the DB, generating it if missing.

    Returns PNG bytes, or None if the user doesn't exist.
    """
    # Read-only query: no write lock needed
    with get_db() as conn:
        row = conn.execute(
            'SELECT avatar_data, color FROM users WHERE username = ?',
            (username,)
        ).fetchone()

    if not row:
        return None

    if row['avatar_data']:
        return bytes(row['avatar_data'])

    # Generate identicon outside DB connection to avoid holding a write lock
    color = row['color'] or '#1976d2'
    avatar_data = generate_identicon(username, color)

    # Short write-only transaction
    with get_db() as conn:
        conn.execute(
            'UPDATE users SET avatar_data = ? WHERE username = ?',
            (avatar_data, username)
        )
        conn.commit()
    return avatar_data
