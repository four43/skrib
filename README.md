# Mini Chat - FastAPI + Vite Application

A secure chat application built with FastAPI backend and Vite frontend, featuring WebAuthn authentication, role-based access control, and SQLite database.

## Features

### Collaboration

- **Multi-Room Chat** - Create and join multiple chat rooms
- **Direct Messages** - Private conversations between users

### Security

- **No spying** - End-to-end Encryption (E2EE) for all messages, 0 knowledge server design
- **Simple Auth** - Passwordless Authentication using Passkeys(WebAuthn) for easy sign-up and usage
  - The only info required for sign-up is a username and a compatible authenticator (e.g. phone biometrics, security key)
- **Simple Moderation**  Role-based access controls for admin, mods, and regular users.

- ✅ **Manual Approval** - Admins approve new registrations
- 🔒 **Registration Control** - Toggle registration on/off from admin panel
- 💬 **Multi-Room Chat** - Create and join multiple chat rooms
- 📦 **Process Isolation** - Each room runs in its own process
- 💾 **SQLite Backend** - Reliable database with proper locking
- 🔄 **WAL Mode** - Write-Ahead Logging for better concurrency
- ⚡ **Vite Frontend** - Modern build tooling with HMR

## Project Structure

```
/workspace
├── backend/              # FastAPI backend
│   ├── mini_chat/       # Python package
│   │   ├── chat_server_webauthn.py
│   │   └── admin_cli.py
│   ├── pyproject.toml
│   └── util/
├── frontend/            # Vite frontend
│   ├── src/
│   │   ├── main.js     # Main JavaScript entry point
│   │   └── style.css   # Styles
│   ├── index.html      # HTML template
│   ├── package.json
│   └── vite.config.js
├── Dockerfile          # Multi-stage build
└── docker-compose.yml
```

## Development

### Prerequisites

- Docker and Docker Compose (recommended)
- OR Node.js 20+ and Python 3.13+ (for local development)

### Quick Start with Docker

Build and run the entire application:

```bash
docker-compose up --build
```

The application will be available at <http://localhost:8000>

### Development Mode with Hot Reload

Run both backend and frontend with hot reload:

```bash
# Start backend with hot reload
docker-compose up app

# In another terminal, start frontend dev server with HMR
docker-compose --profile dev up frontend-dev
```

- Backend: <http://localhost:8000> (auto-reloads on Python file changes)
- Frontend dev server: <http://localhost:5173> (with Hot Module Replacement)

During development, the Vite dev server proxies API requests to the backend.

### Local Development (without Docker)

#### Backend

```bash
cd backend
pip install -e .
python -m uvicorn mini_chat.chat_server_webauthn:app --reload --host 0.0.0.0 --port 8000
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server will proxy `/api` requests to the backend at <http://localhost:8000>

## Building for Production

### Build the Docker image

```bash
docker build -t mini-chat:latest .
```

This creates a multi-stage build that:

1. Builds the frontend with Vite (optimized, minified bundles)
2. Sets up the Python backend
3. Copies the built frontend assets into the final image
4. FastAPI serves the static files

### Build frontend locally

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/` and will be served by FastAPI.

## Initial Setup

### Bootstrap First Admin

Since there are no users initially, you need to:

**Option A: Register normally then promote via CLI**

1. Enable registration: `docker-compose exec app python mini_chat/admin_cli.py toggle-reg`
2. Register through web interface (get approval code)
3. Approve yourself: `docker-compose exec app python mini_chat/admin_cli.py approve <CODE>`
4. Make yourself admin: `docker-compose exec app python mini_chat/admin_cli.py set-admin <USERNAME>`

**Option B: Use CLI interactive mode**

```bash
docker-compose exec app python mini_chat/admin_cli.py

admin> toggle-reg           # Enable registration
admin> list                 # Check pending users
admin> approve A1B2C3D4E5F6 # Approve user
admin> set-admin alice      # Make them admin
admin> toggle-reg           # Disable registration
```

## Environment Variables

### Frontend (Vite)

Create `frontend/.env.local` for local development:

```env
VITE_API_URL=http://localhost:8000/api
```

In production (Docker build), the API URL defaults to `/api` (relative).

### Backend

Environment variables can be set in `docker-compose.yml`:

```env
PYTHONUNBUFFERED=1
```

## API Documentation

Once running, visit:

- Swagger UI: <http://localhost:8000/docs>
- ReDoc: <http://localhost:8000/redoc>

## Technology Stack

### Backend

- **FastAPI** - Modern Python web framework
- **SQLite** - Embedded database with WAL mode
- **WebAuthn** - Passwordless authentication
- **Uvicorn** - ASGI server
- **Pydantic** - Data validation

### Frontend

- **Vite** - Build tool and dev server with HMR
- **Vanilla JavaScript** - Modern ES modules, no framework overhead
- **CSS3** - Modern styling

## Best Practices Implemented

1. **Separation of Concerns**: Backend and frontend are in separate directories
2. **Multi-stage Docker Build**: Optimized image size, frontend built during Docker build
3. **Development Experience**: Hot reload for both backend (uvicorn --reload) and frontend (Vite HMR)
4. **Environment-based Configuration**: Different configs for dev/prod via environment variables
5. **Static File Serving**: FastAPI serves pre-built Vite assets in production
6. **API Proxying**: Vite dev server proxies `/api` requests to backend during development
7. **Type Safety**: Pydantic models for request/response validation
8. **Database Safety**: WAL mode, proper locking, 30s timeout

## Database Schema

The SQLite database (`chat.db`) contains:

### Tables

**users** - Approved users

- username, credential_id, public_key, role, approved, approved_at, approved_by

**pending_users** - Awaiting approval

- username, credential_id, public_key, approval_code, registered_at

**challenges** - WebAuthn challenges

- challenge, type, username, timestamp

**settings** - Server configuration

- key, value (stores registration_enabled flag)

**messages** - Chat messages

- id, room_id, username, message, timestamp

### SQLite Configuration

The database uses:

- **WAL Mode** (Write-Ahead Logging) - Allows concurrent reads with writes
- **30 second timeout** - Handles busy database gracefully
- **Proper locking** - Thread-safe operations
- **Indices** - Fast message queries by room and timestamp

## Admin CLI Commands

```bash
# Interactive mode
docker-compose exec app python mini_chat/admin_cli.py

# Or direct commands
python mini_chat/admin_cli.py list                    # Show pending users
python mini_chat/admin_cli.py approved                # Show all approved users
python mini_chat/admin_cli.py approve <CODE>          # Approve by code
python mini_chat/admin_cli.py reject <CODE>           # Reject registration
python mini_chat/admin_cli.py revoke <USERNAME>       # Remove user access
python mini_chat/admin_cli.py set-admin <USERNAME>    # Promote to admin
python mini_chat/admin_cli.py remove-admin <USERNAME> # Demote from admin
python mini_chat/admin_cli.py toggle-reg              # Toggle registration on/off
python mini_chat/admin_cli.py status                  # Show system status
```

## Workflow

### Registration Flow

1. Admin enables registration (toggle in admin panel or CLI)
2. Friend visits the site and registers with WebAuthn
3. They receive an approval code (e.g., `A1B2C3D4E5F6`)
4. Friend tells you the code
5. You approve via admin panel or CLI
6. Admin disables registration
7. Friend can now login!

### Daily Use

- Registration stays **disabled** by default
- Enable it briefly when friends are nearby
- Disable immediately after they register
- Approve their registration
- They can now access the chat

## Security Notes

- Keep registration **disabled** by default
- Each user gets a unique approval code
- Private keys never leave the user's device
- Admin role required for user management
- Cannot delete the last admin user
- Session tokens are simple (upgrade to JWT for production)
- Database file permissions should be restricted

## Browser Compatibility

WebAuthn requires:

- Chrome/Edge 67+
- Firefox 60+
- Safari 13+

## Tips

- Use the admin panel toggle for quick registration control
- Pending users show up in real-time in the admin panel
- Database is automatically created on first run
- Frontend HMR provides instant feedback during development
- Build the Docker image for production deployment
