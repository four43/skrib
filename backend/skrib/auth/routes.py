"""Authentication API routes."""
from fastapi import APIRouter, Form, HTTPException, Depends, Query
from fastapi.responses import RedirectResponse
from typing import Optional
from urllib.parse import urlencode

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
    RegistrationTokenInfoResponse,
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
    is_username_taken,
    create_registration_token,
    get_registration_token_info,
)
from ..dependencies import get_username_from_token, require_auth
from ..database import get_db
from ..config import WEBAUTHN_RP_NAME, WEBAUTHN_RP_ID

router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post("/register/step1")
async def register_step1(
    username: str = Form(...),
    invite: Optional[str] = Form(None),
):
    """Step 1: Accept form POST with username.

    The form also contains a password field (type=password, autocomplete=new-password)
    so that password managers detect the submission and offer to save credentials.
    That field intentionally has no name= attribute so the passphrase is never
    transmitted to the server.
    """
    def _register_error(msg: str, uname: str = "", inv: str = "") -> RedirectResponse:
        params = {"error": msg}
        if uname:
            params["username"] = uname
        if inv:
            params["invite"] = inv
        return RedirectResponse(url=f"/register.html?{urlencode(params)}", status_code=303)

    if not is_registration_allowed(invite_token=invite):
        mode = get_registration_mode()
        if mode == 'closed':
            return _register_error("Registration is currently closed")
        elif mode == 'invite_only':
            return _register_error("Registration requires a valid invite link")
        else:
            return _register_error("Registration is not available")

    username_error = validate_username(username)
    if username_error:
        return _register_error(username_error, username, invite or "")

    if is_username_taken(username):
        return _register_error("Username is already taken", username, invite or "")

    token = create_registration_token(username)
    params = {'token': token}
    if invite:
        params['invite'] = invite
    return RedirectResponse(url=f"/enroll-passkey.html?{urlencode(params)}", status_code=303)


@router.get("/register/token-info", response_model=RegistrationTokenInfoResponse)
async def register_token_info(token: str = Query(...)):
    """Return the username associated with a step-1 registration token."""
    info = get_registration_token_info(token)
    if not info:
        raise HTTPException(status_code=404, detail="Invalid or expired registration token")
    return RegistrationTokenInfoResponse(username=info['username'])


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
            invite_token=request.invite_token,
            encryption_public_key=request.encryption_public_key,
            passphrase_encrypted_private_key=request.passphrase_encrypted_private_key,
            encrypted_private_key=request.encrypted_private_key,
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
    """Store the user's encryption public key (JWK) and optional wrapped private key backups."""
    with get_db() as conn:
        fields = ['encryption_public_key = ?']
        params = [request.public_key]
        if request.encrypted_private_key is not None:
            fields.append('encrypted_private_key = ?')
            params.append(request.encrypted_private_key)
        if request.passphrase_encrypted_private_key is not None:
            fields.append('passphrase_encrypted_private_key = ?')
            params.append(request.passphrase_encrypted_private_key)
        params.append(username)
        conn.execute(
            f'UPDATE users SET {", ".join(fields)} WHERE username = ?',
            params,
        )
        conn.commit()
    return {}


@router.get("/encryption-key/{target_username}", response_model=EncryptionKeyResponse)
async def get_encryption_key(
    target_username: str,
    _: str = Depends(require_auth),
):
    """Get a user's encryption public key and optional wrapped private key backups."""
    with get_db() as conn:
        cursor = conn.execute(
            'SELECT encryption_public_key, encrypted_private_key, passphrase_encrypted_private_key FROM users WHERE username = ? AND status = ?',
            (target_username, 'active'),
        )
        row = cursor.fetchone()
    if not row or not row['encryption_public_key']:
        raise HTTPException(status_code=404, detail="Encryption key not found for user")
    return EncryptionKeyResponse(
        username=target_username,
        public_key=row['encryption_public_key'],
        encrypted_private_key=row['encrypted_private_key'],
        passphrase_encrypted_private_key=row['passphrase_encrypted_private_key'],
    )
