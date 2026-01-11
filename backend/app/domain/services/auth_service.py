"""Authentication service."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import bcrypt
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.domain.models import User

if TYPE_CHECKING:
    from app.domain.schemas import UserCreate


class AuthService:
    """Authentication service for user management."""

    ALGORITHM = "HS256"
    ACCESS_TOKEN_EXPIRE_HOURS = 24

    def __init__(self, db: AsyncSession) -> None:
        """Initialize auth service."""
        self.db = db

    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a password using bcrypt."""
        salt = bcrypt.gensalt()
        return bcrypt.hashpw(password.encode(), salt).decode()

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        """Verify a password against its hash."""
        return bcrypt.checkpw(password.encode(), password_hash.encode())

    def create_access_token(self, user_id: int, username: str) -> str:
        """Create a JWT access token."""
        expire = datetime.now(UTC) + timedelta(hours=self.ACCESS_TOKEN_EXPIRE_HOURS)
        payload = {
            "sub": str(user_id),
            "username": username,
            "exp": expire,
            "iat": datetime.now(UTC),
        }
        return jwt.encode(payload, settings.secret_key, algorithm=self.ALGORITHM)

    def decode_token(self, token: str) -> dict | None:
        """Decode and validate a JWT token."""
        try:
            payload = jwt.decode(token, settings.secret_key, algorithms=[self.ALGORITHM])
            return payload
        except jwt.PyJWTError:
            return None

    async def get_user_by_username(self, username: str) -> User | None:
        """Get a user by username."""
        result = await self.db.execute(select(User).where(User.username == username))
        return result.scalar_one_or_none()

    async def get_user_by_id(self, user_id: int) -> User | None:
        """Get a user by ID."""
        result = await self.db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()

    async def create_user(self, user_data: UserCreate) -> User:
        """Create a new user."""
        password_hash = self.hash_password(user_data.password)
        user = User(
            username=user_data.username,
            password_hash=password_hash,
            gpg_key_id=user_data.gpg_key_id,
        )
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def authenticate(self, username: str, password: str) -> User | None:
        """Authenticate a user."""
        user = await self.get_user_by_username(username)
        if not user:
            return None
        if not self.verify_password(password, user.password_hash):
            return None
        if not user.is_active:
            return None

        # Update last login
        user.last_login = datetime.now(UTC)
        await self.db.commit()

        return user

    async def update_gpg_key(self, user_id: int, gpg_key_id: str) -> User | None:
        """Update user's GPG key ID."""
        user = await self.get_user_by_id(user_id)
        if not user:
            return None
        user.gpg_key_id = gpg_key_id
        await self.db.commit()
        await self.db.refresh(user)
        return user
