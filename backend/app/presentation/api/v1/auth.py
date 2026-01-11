"""Authentication API endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import User
from app.domain.schemas import Token, UserCreate, UserLogin, UserResponse
from app.domain.services.auth_service import AuthService
from app.infrastructure.database import get_db

router = APIRouter()
security = HTTPBearer()


async def get_auth_service(db: AsyncSession = Depends(get_db)) -> AuthService:
    """Get auth service dependency."""
    return AuthService(db)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    auth_service: AuthService = Depends(get_auth_service),
) -> User:
    """Get current authenticated user."""
    payload = auth_service.decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = int(payload.get("sub", 0))
    user = await auth_service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(
    user_data: UserCreate,
    auth_service: AuthService = Depends(get_auth_service),
) -> User:
    """Register a new user."""
    existing = await auth_service.get_user_by_username(user_data.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already registered",
        )

    return await auth_service.create_user(user_data)


@router.post("/login", response_model=Token)
async def login(
    credentials: UserLogin,
    auth_service: AuthService = Depends(get_auth_service),
) -> Token:
    """Login and get access token."""
    user = await auth_service.authenticate(credentials.username, credentials.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_service.create_access_token(user.id, user.username)
    return Token(
        access_token=token,
        token_type="bearer",
        expires_in=auth_service.ACCESS_TOKEN_EXPIRE_HOURS * 3600,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    """Get current user info."""
    return current_user


@router.put("/me/gpg-key", response_model=UserResponse)
async def update_gpg_key(
    gpg_key_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    auth_service: AuthService = Depends(get_auth_service),
) -> User:
    """Update user's GPG key ID."""
    user = await auth_service.update_gpg_key(current_user.id, gpg_key_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return user
