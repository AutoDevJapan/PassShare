"""Database configuration for PostgreSQL."""

import logging
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Base class for all models."""
    pass


# Database engine (lazy initialization)
_engine: AsyncEngine | None = None
_async_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine | None:
    """Get or create the database engine."""
    global _engine
    if _engine is None and settings.database_url:
        try:
            _engine = create_async_engine(
                settings.get_database_url,
                echo=settings.debug,
                pool_size=10,
                max_overflow=20,
                pool_pre_ping=True,
            )
        except Exception as e:
            logger.warning(f"Failed to create database engine: {e}")
            return None
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession] | None:
    """Get or create the session factory."""
    global _async_session_factory
    engine = get_engine()
    if engine is None:
        return None
    if _async_session_factory is None:
        _async_session_factory = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autocommit=False,
            autoflush=False,
        )
    return _async_session_factory


# For backward compatibility
@property
def engine():
    return get_engine()


@property
def async_session_factory():
    return get_session_factory()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Get database session."""
    factory = get_session_factory()
    if factory is None:
        raise RuntimeError("Database not configured")
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db() -> None:
    """Initialize database tables."""
    engine = get_engine()
    if engine is None:
        logger.warning("Database not configured, skipping initialization")
        return
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database initialized successfully")
    except Exception as e:
        logger.warning(f"Failed to initialize database: {e}")


async def close_db() -> None:
    """Close database connections."""
    engine = get_engine()
    if engine is not None:
        await engine.dispose()
