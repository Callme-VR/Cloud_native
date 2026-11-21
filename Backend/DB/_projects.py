"""
Database Models & Persistence Layer (Neon PostgreSQL)
------------------------------------------------------
Manages relational schema, async connection pooling, and CRUD operations for:
  - Projects (Repositories)
  - Agent Runs (Task prompts, execution statuses, summaries, git diffs)
  - Execution Steps (Every thought, tool call, and tool result trace)
"""

import os
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from dotenv import load_dotenv
from sqlalchemy import String, Text, Integer, DateTime, ForeignKey, JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    AsyncAttrs,
    create_async_engine,
    async_sessionmaker,
)
from rich.console import Console

load_dotenv()
console = Console()

# 1. Database Connection Configuration
DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    console.print("[yellow]⚠ DATABASE_URL not set in .env. Falling back to local SQLite for testing.[/yellow]")
    DATABASE_URL = "sqlite+aiosqlite:///./sandbox_dev.db"

# Create Async Engine with connection pooling
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,  # Automatically detects and recovers dropped serverless connections
)

# Async session factory
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


# 2. Database Models
class Base(AsyncAttrs, DeclarativeBase):
    pass


class Project(Base):
    """Represents a code repository tracked by the harness."""
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    repo_url: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    runs: Mapped[list["AgentRun"]] = relationship("AgentRun", back_populates="project", cascade="all, delete-orphan")


class AgentRun(Base):
    """Represents an autonomous coding session / agent run."""
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    task_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="PENDING")  # PENDING, RUNNING, COMPLETED, FAILED
    model_name: Mapped[str] = mapped_column(String(100), default="gemini-2.5-flash")
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    git_diff: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project | None] = relationship("Project", back_populates="runs")
    steps: Mapped[list["ExecutionStep"]] = relationship("ExecutionStep", back_populates="run", cascade="all, delete-orphan")


class ExecutionStep(Base):
    """Stores every step in the agent's ReAct execution trace."""
    __tablename__ = "execution_steps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False)
    step_number: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
    tool_args: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    tool_result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    run: Mapped[AgentRun] = relationship("AgentRun", back_populates="steps")


# 3. Database CRUD Operations
async def init_db():
    """Initializes and creates all database tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    console.print("[green]✔ Database schema initialized successfully.[/green]")


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for acquiring async database sessions."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def create_agent_run(session: AsyncSession, task_prompt: str, model_name: str = "gemini-2.5-flash") -> AgentRun:
    """Creates and persists a new agent run in PENDING status."""
    run = AgentRun(
        task_prompt=task_prompt,
        status="PENDING",
        model_name=model_name,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


async def record_execution_step(
    session: AsyncSession,
    run_id: str,
    step_number: int,
    tool_name: str,
    tool_args: dict[str, Any],
    tool_result: dict[str, Any]
) -> ExecutionStep:
    """Logs an individual tool call and its execution result."""
    step = ExecutionStep(
        run_id=run_id,
        step_number=step_number,
        tool_name=tool_name,
        tool_args=tool_args,
        tool_result=tool_result,
    )
    session.add(step)
    await session.commit()
    return step


async def finalize_agent_run(
    session: AsyncSession,
    run_id: str,
    status: str,
    summary: str,
    git_diff: str | None = None
) -> AgentRun | None:
    """Marks an agent run as COMPLETED or FAILED with final summary and patch."""
    run = await session.get(AgentRun, run_id)
    if run:
        run.status = status
        run.summary = summary
        run.git_diff = git_diff
        run.completed_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(run)
    return run


# 4. Self-Test Script
if __name__ == "__main__":
    import asyncio

    async def test_database():
        console.rule("[bold magenta]Testing Neon PostgreSQL / Database Layer")
        
        # 1. Create tables
        await init_db()

        # 2. Test inserting an Agent Run
        async with AsyncSessionLocal() as session:
            console.print("[cyan]Creating test AgentRun in Neon...[/cyan]")
            new_run = await create_agent_run(session, "Fix ZeroDivisionError in calculator.py")
            console.print(f"[green]✔ AgentRun Created in Neon:[/green] ID={new_run.id}, Status={new_run.status}")

            # 3. Test recording an execution step
            console.print("[cyan]Recording execution step...[/cyan]")
            step = await record_execution_step(
                session=session,
                run_id=new_run.id,
                step_number=1,
                tool_name="read_file",
                tool_args={"path": "src/calculator.py"},
                tool_result={"status": "success", "content": "def divide(a, b): return a / b"}
            )
            console.print(f"[green]✔ Step Recorded in Neon:[/green] Step {step.step_number} -> {step.tool_name}")

            # 4. Finalize run
            console.print("[cyan]Finalizing run in Neon...[/cyan]")
            final_run = await finalize_agent_run(
                session=session,
                run_id=new_run.id,
                status="COMPLETED",
                summary="Patched calculator.py to return None on divide-by-zero.",
                git_diff="--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1,2 @@\n-def divide(a, b): return a / b\n+def divide(a, b):\n+    return a / b if b != 0 else None"
            )
            console.print(f"[bold green]✔ AgentRun Finalized in Neon:[/bold green] Status={final_run.status}")

        console.rule("[bold green]Neon PostgreSQL Verification Succeeded!")

    asyncio.run(test_database())
