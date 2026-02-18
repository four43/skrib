"""Authentication API routes."""
from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional

from .schemas import (
    RegistrationBeginResponse,
    RegistrationCompleteRequest,
    RegistrationCompleteResponse,
    LoginBeginResponse,
    LoginCompleteRequest,
    LoginCompleteResponse,
    SessionResponse,
    StoreEncryptionKeyRequest,
    EncryptionKeyResponse,
)
from .services import (
    generate_challenge,
    store_challenge,
    verify_challenge,
    is_registration_allowed,
    get_registration_mode,
    create_pending_user,
    get_user_by_credential,
    create_session_token,
    validate_username,
)
from ..dependencies import get_username_from_token, require_auth
from ..database import get_db
from ..config import WEBAUTHN_RP_NAME, WEBAUTHN_RP_ID

router = APIRouter(prefix="/auth", tags=["authentication"])


@router.get("/register/begin", response_model=RegistrationBeginResponse)
async def begin_registration(invite: Optional[str] = Query(None)):
    """Begin WebAuthn registration process."""
    if not is_registration_allowed(invite_token=invite):
        mode = get_registration_mode()
        if mode == 'closed':
            raise HTTPException(status_code=403, detail="Registration is currently closed")
        elif mode == 'invite_only':
            raise HTTPException(status_code=403, detail="Registration requires a valid invite link")
        else:
            raise HTTPException(status_code=403, detail="Registration is not available")

    challenge = generate_challenge()
    store_challenge(challenge, 'registration')

    return RegistrationBeginResponse(
        challenge=challenge,
        rp={'name': WEBAUTHN_RP_NAME, 'id': WEBAUTHN_RP_ID}
    )


@router.post("/register/complete", response_model=RegistrationCompleteResponse)
async def complete_registration(request: RegistrationCompleteRequest):
    """Complete WebAuthn registration."""
    if not is_registration_allowed(invite_token=request.invite_token):
        mode = get_registration_mode()
        if mode == 'closed':
            raise HTTPException(status_code=403, detail="Registration is currently closed")
        elif mode == 'invite_only':
            raise HTTPException(status_code=403, detail="Registration requires a valid invite link")
        else:
            raise HTTPException(status_code=403, detail="Registration is not available")

    if not verify_challenge(request.challenge, 'registration'):
        raise HTTPException(status_code=400, detail="Invalid or expired challenge")

    username_error = validate_username(request.username)
    if username_error:
        raise HTTPException(status_code=400, detail=username_error)

    try:
        approval_code, is_auto_approved = create_pending_user(
            request.username,
            request.credentialId,
            request.publicKey,
            invite_token=request.invite_token
        )

        if is_auto_approved:
            return RegistrationCompleteResponse(
                status='approved',
                approval_code='AUTO_APPROVED'
            )
        else:
            return RegistrationCompleteResponse(
                status='pending',
                approval_code=approval_code
            )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Registration failed: {str(e)}")


@router.get("/login/begin", response_model=LoginBeginResponse)
async def begin_login():
    """Begin WebAuthn login process - usernameless flow."""
    challenge = generate_challenge()
    store_challenge(challenge, 'login', None)

    # Empty allowCredentials means any credential can be used (discoverable credentials)
    return LoginBeginResponse(
        challenge=challenge,
        rpId=WEBAUTHN_RP_ID,
        allowCredentials=[]
    )


@router.post("/login/complete", response_model=LoginCompleteResponse)
async def complete_login(request: LoginCompleteRequest):
    """Complete WebAuthn login - identifies user by credential."""
    if not verify_challenge(request.challenge, 'login', None):
        raise HTTPException(status_code=400, detail="Invalid or expired challenge")

    # Identify user by their credential ID
    user = get_user_by_credential(request.credentialId)
    if not user:
        raise HTTPException(status_code=404, detail="User not found or not approved")

    session_token = create_session_token(user['username'])

    return LoginCompleteResponse(
        status='ok',
        session_token=session_token,
        username=user['username'],
        role=user['role']
    )


@router.get("/session", response_model=SessionResponse)
async def check_session(username: Optional[str] = Depends(get_username_from_token)):
    """Check if session is valid."""
    if username:
        from ..database import get_db
        with get_db() as conn:
            cursor = conn.execute('SELECT role FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if row:
                return SessionResponse(
                    authenticated=True,
                    username=username,
                    role=row['role']
                )

    return SessionResponse(authenticated=False)


@router.post("/encryption-key")
async def store_encryption_key(
    request: StoreEncryptionKeyRequest,
    username: str = Depends(require_auth),
):
    """Store the user's encryption public key (JWK)."""
    with get_db() as conn:
        conn.execute(
            'UPDATE users SET encryption_public_key = ? WHERE username = ?',
            (request.public_key, username),
        )
        conn.commit()
    return {"status": "ok"}


@router.get("/encryption-key/{target_username}", response_model=EncryptionKeyResponse)
async def get_encryption_key(
    target_username: str,
    _: str = Depends(require_auth),
):
    """Get a user's encryption public key."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT encryption_public_key FROM users WHERE username = ? AND status = ?',
            (target_username, 'active'),
        )
        row = cursor.fetchone()
    if not row or not row['encryption_public_key']:
        raise HTTPException(status_code=404, detail="Encryption key not found for user")
    return EncryptionKeyResponse(username=target_username, public_key=row['encryption_public_key'])
