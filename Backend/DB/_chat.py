"""
Chat Sessions & Conversational Memory Layer (Neon PostgreSQL)
--------------------------------------------------------------
Manages relational schema and CRUD operations for:
  - Chat Sessions (Multi-turn conversations, titles, models, timestamps)
  - Chat Messages (Chronological user and assistant interaction history)
"""

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import String, Text, DateTime, ForeignKey, JSON, select
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.ext.asyncio import AsyncSession
from rich.console import Console

from DB._projects import Base

console = Console()


# 1. Database Models
class ChatSession(Base):
    """Represents a persistent conversational thread / session."""
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    title: Mapped[str] = mapped_column(String(255), default="New Chat")
    model_name: Mapped[str] = mapped_column(String(100), default="gemini-2.5-flash")
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc)
    )

    messages: Mapped[list["ChatMessage"]] = relationship(
        "ChatMessage",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.created_at"
    )


class ChatMessage(Base):
    """Represents an individual message in a chat session (user, assistant, or system)."""
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)  # "user", "assistant", "system"
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    session: Mapped[ChatSession] = relationship("ChatSession", back_populates="messages")


# 2. Database CRUD Operations
async def create_chat_session(
    session: AsyncSession,
    title: str = "New Chat",
    model_name: str = "gemini-2.5-flash",
    system_prompt: str | None = None,
    project_id: str | None = None,
) -> ChatSession:
    """Creates a new conversational chat session."""
    chat = ChatSession(
        title=title,
        model_name=model_name,
        system_prompt=system_prompt,
        project_id=project_id,
    )
    session.add(chat)
    await session.commit()
    await session.refresh(chat)
    return chat


async def list_chat_sessions(
    session: AsyncSession,
    limit: int = 50,
    offset: int = 0
) -> list[ChatSession]:
    """Lists recent chat sessions ordered by latest activity."""
    stmt = (
        select(ChatSession)
        .order_by(ChatSession.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_chat_session(
    session: AsyncSession,
    session_id: str
) -> ChatSession | None:
    """Fetches a chat session by ID."""
    return await session.get(ChatSession, session_id)


async def get_chat_history(
    session: AsyncSession,
    session_id: str
) -> list[ChatMessage]:
    """Retrieves all messages for a given session in chronological order."""
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def update_chat_session(
    session: AsyncSession,
    session_id: str,
    title: str | None = None,
    model_name: str | None = None,
    system_prompt: str | None = None
) -> ChatSession | None:
    """Updates the title, model, or system prompt of an existing chat session."""
    chat = await session.get(ChatSession, session_id)
    if chat:
        if title is not None:
            chat.title = title
        if model_name is not None:
            chat.model_name = model_name
        if system_prompt is not None:
            chat.system_prompt = system_prompt
        chat.updated_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(chat)
    return chat


async def delete_chat_session(
    session: AsyncSession,
    session_id: str
) -> bool:
    """Deletes a chat session and cascades all messages."""
    chat = await session.get(ChatSession, session_id)
    if chat:
        await session.delete(chat)
        await session.commit()
        return True
    return False


async def add_chat_message(
    session: AsyncSession,
    session_id: str,
    role: str,
    content: str,
    metadata_json: dict[str, Any] | None = None
) -> ChatMessage:
    """Appends an individual message to a session and updates the session's timestamp."""
    message = ChatMessage(
        session_id=session_id,
        role=role,
        content=content,
        metadata_json=metadata_json or {},
    )
    session.add(message)

    # Bump the parent session's updated_at
    chat = await session.get(ChatSession, session_id)
    if chat:
        chat.updated_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(message)
    return message
