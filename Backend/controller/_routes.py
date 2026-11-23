"""
API Gateway & Real-Time Streaming Controller
--------------------------------------------
Provides REST endpoints and WebSocket channels for:
  - Launching agent runs (`POST /runs`)
  - Streaming live traces (`WebSocket /runs/{run_id}/stream`)
  - Querying runs & execution history (`GET /runs`, `GET /runs/{run_id}`)
  - Inspecting generated patches from Neon Object Storage (`GET /runs/{run_id}/diff`)
"""

import asyncio
import os
from typing import Any
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from google import genai
from google.genai import types
from rich.console import Console

from DB import (
    get_db,
    create_agent_run,
    record_execution_step,
    finalize_agent_run,
    delete_agent_run,
    AgentRun,
    ExecutionStep,
    AsyncSessionLocal,
    ChatSession,
    ChatMessage,
    create_chat_session,
    list_chat_sessions,
    get_chat_session,
    get_chat_history,
    update_chat_session,
    delete_chat_session,
    add_chat_message,
    NeonObjectStorage,
)
from Harness._agent_loop import run_agent_loop

console = Console()
api_router = APIRouter(prefix="/api", tags=["Agent Runs"])


# 1. Pydantic Request & Response Schemas
class LaunchRunRequest(BaseModel):
    task_prompt: str = Field(..., description="Prompt describing the coding task or bug to fix.")
    model_name: str = Field(default="gemini-2.5-flash", description="LLM model identifier.")
    max_iterations: int = Field(default=12, ge=1, le=25, description="Safety limit on ReAct loops.")


class RunResponse(BaseModel):
    id: str
    task_prompt: str
    status: str
    model_name: str
    summary: str | None = None
    git_diff: str | None = None
    created_at: str
    completed_at: str | None = None


# Chat Session Request & Response Schemas
class CreateChatRequest(BaseModel):
    title: str = Field(default="New Chat", description="Title for the conversation.")
    model_name: str = Field(default="gemini-2.5-flash", description="Gemini model to use.")
    system_prompt: str | None = Field(default=None, description="Optional custom system prompt.")
    project_id: str | None = Field(default=None, description="Optional linked project ID.")


class UpdateChatRequest(BaseModel):
    title: str | None = Field(default=None, description="Updated conversation title.")
    model_name: str | None = Field(default=None, description="Updated model identifier.")
    system_prompt: str | None = Field(default=None, description="Updated system prompt.")


class SendMessageRequest(BaseModel):
    content: str = Field(..., description="User message text to send.")


class ChatMessageResponse(BaseModel):
    id: str
    session_id: str
    role: str
    content: str
    metadata_json: dict[str, Any] = {}
    created_at: str


class ChatSessionResponse(BaseModel):
    id: str
    title: str
    model_name: str
    system_prompt: str | None = None
    project_id: str | None = None
    created_at: str
    updated_at: str


class ChatSessionDetailResponse(ChatSessionResponse):
    messages: list[ChatMessageResponse] = []


# 2. WebSocket Connection Manager for Live Streaming
class ConnectionManager:
    """Manages active WebSocket client connections keyed by run_id."""

    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, run_id: str, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            if run_id not in self.active_connections:
                self.active_connections[run_id] = []
            self.active_connections[run_id].append(websocket)
        console.print(f"[cyan]WebSocket client connected to run:[/cyan] {run_id}")

    async def disconnect(self, run_id: str, websocket: WebSocket):
        async with self._lock:
            if run_id in self.active_connections:
                if websocket in self.active_connections[run_id]:
                    self.active_connections[run_id].remove(websocket)
                if not self.active_connections[run_id]:
                    del self.active_connections[run_id]
        console.print(f"[yellow]WebSocket client disconnected from run:[/yellow] {run_id}")

    async def broadcast(self, run_id: str, message: dict[str, Any]):
        async with self._lock:
            websockets = list(self.active_connections.get(run_id, []))
        for connection in websockets:
            try:
                await connection.send_json(message)
            except Exception:
                pass


manager = ConnectionManager()
storage = NeonObjectStorage()


# 3. Background Autonomous Worker
def _execute_agent_background(
    run_id: str,
    task_prompt: str,
    model_name: str,
    max_iterations: int,
    loop: asyncio.AbstractEventLoop
):
    """
    Runs in a background thread to prevent blocking FastAPI's async event loop.
    Emits events via `event_callback` directly into WebSocket channels and Neon DB.
    """
    async def _async_step_callback(event_data: dict[str, Any]):
        # Broadcast to all live WebSocket subscribers
        await manager.broadcast(run_id, event_data)

        # Record tool calls to Neon PostgreSQL
        if event_data.get("event") == "tool_execution":
            async with AsyncSessionLocal() as session:
                await record_execution_step(
                    session=session,
                    run_id=run_id,
                    step_number=event_data["step"],
                    tool_name=event_data["tool"],
                    tool_args=event_data["args"],
                    tool_result=event_data["result"]
                )

    def sync_event_callback(event_data: dict[str, Any]):
        # Bridge thread execution back to the main asyncio event loop
        asyncio.run_coroutine_threadsafe(_async_step_callback(event_data), loop)

    try:
        # Notify clients that run has transitioned from PENDING to RUNNING
        asyncio.run_coroutine_threadsafe(
            manager.broadcast(run_id, {"event": "status", "status": "RUNNING"}),
            loop
        )

        # Run the autonomous ReAct state machine inside Docker
        result = run_agent_loop(
            task_prompt=task_prompt,
            max_iterations=max_iterations,
            model_name=model_name,
            interactive_destroy=False,  # Automated container destruction
            event_callback=sync_event_callback
        )

        git_diff = result.get("diff") or ""
        summary = result.get("summary") or "Task completed."
        status = "COMPLETED" if result.get("status") == "completed" else "FAILED"

        # Upload generated patch to Neon Object Storage
        if git_diff.strip():
            storage.upload_patch(run_id, git_diff)

        # Finalize status in Neon PostgreSQL
        async def _finalize():
            async with AsyncSessionLocal() as session:
                await finalize_agent_run(
                    session=session,
                    run_id=run_id,
                    status=status,
                    summary=summary,
                    git_diff=git_diff
                )
            await manager.broadcast(run_id, {
                "event": "finish",
                "status": status,
                "summary": summary,
                "diff": git_diff
            })

        asyncio.run_coroutine_threadsafe(_finalize(), loop)

    except Exception as e:
        error_msg = str(e)
        if "CreateFile" in error_msg or "docker" in error_msg.lower():
            error_msg = "Docker daemon is offline. Please launch Docker Desktop to execute sandbox tasks."
        console.print(f"[bold red]Background run {run_id} failed: {error_msg}[/bold red]")
        async def _record_failure():
            async with AsyncSessionLocal() as session:
                await finalize_agent_run(
                    session=session,
                    run_id=run_id,
                    status="FAILED",
                    summary=f"Execution error: {error_msg}"
                )
            await manager.broadcast(run_id, {
                "event": "finish",
                "status": "FAILED",
                "summary": f"Execution failed: {error_msg}"
            })
        asyncio.run_coroutine_threadsafe(_record_failure(), loop)


# 4. REST Endpoints
@api_router.post("/runs", response_model=RunResponse, status_code=201)
async def launch_run(
    payload: LaunchRunRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Creates a new agent run in Neon PostgreSQL and launches the ReAct loop in the background.
    """
    new_run = await create_agent_run(
        session=db,
        task_prompt=payload.task_prompt,
        model_name=payload.model_name
    )

    loop = asyncio.get_running_loop()
    loop.run_in_executor(
        None,
        _execute_agent_background,
        new_run.id,
        payload.task_prompt,
        payload.model_name,
        payload.max_iterations,
        loop
    )

    return RunResponse(
        id=new_run.id,
        task_prompt=new_run.task_prompt,
        status=new_run.status,
        model_name=new_run.model_name,
        summary=new_run.summary,
        git_diff=new_run.git_diff,
        created_at=new_run.created_at.isoformat(),
        completed_at=new_run.completed_at.isoformat() if new_run.completed_at else None
    )


@api_router.get("/runs", response_model=list[RunResponse])
async def list_runs(db: AsyncSession = Depends(get_db)):
    """Lists the latest 20 agent runs from Neon PostgreSQL."""
    stmt = select(AgentRun).order_by(AgentRun.created_at.desc()).limit(20)
    result = await db.execute(stmt)
    runs = result.scalars().all()

    return [
        RunResponse(
            id=r.id,
            task_prompt=r.task_prompt,
            status=r.status,
            model_name=r.model_name,
            summary=r.summary,
            git_diff=r.git_diff,
            created_at=r.created_at.isoformat(),
            completed_at=r.completed_at.isoformat() if r.completed_at else None
        )
        for r in runs
    ]


@api_router.get("/runs/{run_id}")
async def get_run_details(run_id: str, db: AsyncSession = Depends(get_db)):
    """Fetches details for a single run, including all recorded execution steps."""
    run = await db.get(AgentRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Agent run not found")

    stmt = select(ExecutionStep).where(ExecutionStep.run_id == run_id).order_by(ExecutionStep.step_number.asc())
    result = await db.execute(stmt)
    steps = result.scalars().all()

    return {
        "id": run.id,
        "task_prompt": run.task_prompt,
        "status": run.status,
        "model_name": run.model_name,
        "summary": run.summary,
        "git_diff": run.git_diff,
        "created_at": run.created_at.isoformat(),
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "steps": [
            {
                "step_number": s.step_number,
                "tool_name": s.tool_name,
                "tool_args": s.tool_args,
                "tool_result": s.tool_result,
                "created_at": s.created_at.isoformat()
            }
            for s in steps
        ]
    }


@api_router.get("/runs/{run_id}/diff")
async def get_run_diff(run_id: str, db: AsyncSession = Depends(get_db)):
    """
    Downloads the generated patch file from Neon Object Storage,
    or falls back to database record if available. Returns an empty patch if none yet.
    """
    run = await db.get(AgentRun, run_id)
    if not run:
        return {"run_id": run_id, "patch": ""}

    diff_text = storage.download_patch(run_id)
    if not diff_text and run.git_diff:
        diff_text = run.git_diff

    return {"run_id": run_id, "patch": diff_text or ""}


@api_router.delete("/runs/{run_id}", tags=["Agent Runs"])
async def delete_run(run_id: str, db: AsyncSession = Depends(get_db)):
    """Deletes an agent run, its recorded execution steps, and any stored patch artifacts."""
    success = await delete_agent_run(session=db, run_id=run_id)
    if not success:
        raise HTTPException(status_code=404, detail="Agent run not found")

    storage.delete_patch(run_id)
    return {
        "message": "Agent run and execution steps deleted successfully",
        "id": run_id
    }


# 5. WebSocket Real-Time Channel
@api_router.websocket("/runs/{run_id}/stream")
async def stream_run_events(websocket: WebSocket, run_id: str):
    """
    Full-duplex WebSocket channel streaming agent thoughts, tool logs, and status updates in real-time.
    """
    await manager.connect(run_id, websocket)
    try:
        while True:
            # Keep socket open and listen for optional client keep-alive pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(run_id, websocket)


# 6. Chat Session & Conversational Memory Endpoints
@api_router.post("/chats", response_model=ChatSessionResponse, status_code=201, tags=["Chat Sessions"])
async def create_chat(
    payload: CreateChatRequest,
    db: AsyncSession = Depends(get_db)
):
    """Creates a new conversational chat session in Neon PostgreSQL."""
    chat = await create_chat_session(
        session=db,
        title=payload.title,
        model_name=payload.model_name,
        system_prompt=payload.system_prompt,
        project_id=payload.project_id
    )
    return ChatSessionResponse(
        id=chat.id,
        title=chat.title,
        model_name=chat.model_name,
        system_prompt=chat.system_prompt,
        project_id=chat.project_id,
        created_at=chat.created_at.isoformat(),
        updated_at=chat.updated_at.isoformat()
    )


@api_router.get("/chats", response_model=list[ChatSessionResponse], tags=["Chat Sessions"])
async def list_chats(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """Lists all chat sessions ordered by latest updated activity (for the frontend sidebar)."""
    chats = await list_chat_sessions(session=db, limit=limit, offset=offset)
    return [
        ChatSessionResponse(
            id=c.id,
            title=c.title,
            model_name=c.model_name,
            system_prompt=c.system_prompt,
            project_id=c.project_id,
            created_at=c.created_at.isoformat(),
            updated_at=c.updated_at.isoformat()
        )
        for c in chats
    ]


@api_router.get("/chats/{chat_id}", response_model=ChatSessionDetailResponse, tags=["Chat Sessions"])
async def get_chat_details(
    chat_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Fetches a chat session with its full historical messages in chronological order."""
    chat = await get_chat_session(session=db, session_id=chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat session not found")

    history = await get_chat_history(session=db, session_id=chat_id)
    return ChatSessionDetailResponse(
        id=chat.id,
        title=chat.title,
        model_name=chat.model_name,
        system_prompt=chat.system_prompt,
        project_id=chat.project_id,
        created_at=chat.created_at.isoformat(),
        updated_at=chat.updated_at.isoformat(),
        messages=[
            ChatMessageResponse(
                id=m.id,
                session_id=m.session_id,
                role=m.role,
                content=m.content,
                metadata_json=m.metadata_json or {},
                created_at=m.created_at.isoformat()
            )
            for m in history
        ]
    )


@api_router.get("/chats/{chat_id}/history", response_model=list[ChatMessageResponse], tags=["Chat Sessions"])
async def get_chat_message_history(
    chat_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Retrieves only the message history array for a chat session."""
    chat = await get_chat_session(session=db, session_id=chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat session not found")

    history = await get_chat_history(session=db, session_id=chat_id)
    return [
        ChatMessageResponse(
            id=m.id,
            session_id=m.session_id,
            role=m.role,
            content=m.content,
            metadata_json=m.metadata_json or {},
            created_at=m.created_at.isoformat()
        )
        for m in history
    ]


@api_router.patch("/chats/{chat_id}", response_model=ChatSessionResponse, tags=["Chat Sessions"])
async def update_chat(
    chat_id: str,
    payload: UpdateChatRequest,
    db: AsyncSession = Depends(get_db)
):
    """Updates chat session metadata (title, model, or system prompt)."""
    chat = await update_chat_session(
        session=db,
        session_id=chat_id,
        title=payload.title,
        model_name=payload.model_name,
        system_prompt=payload.system_prompt
    )
    if not chat:
        raise HTTPException(status_code=404, detail="Chat session not found")

    return ChatSessionResponse(
        id=chat.id,
        title=chat.title,
        model_name=chat.model_name,
        system_prompt=chat.system_prompt,
        project_id=chat.project_id,
        created_at=chat.created_at.isoformat(),
        updated_at=chat.updated_at.isoformat()
    )


@api_router.delete("/chats/{chat_id}", tags=["Chat Sessions"])
async def delete_chat(
    chat_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Deletes a chat session and cascades all messages."""
    success = await delete_chat_session(session=db, session_id=chat_id)
    if not success:
        raise HTTPException(status_code=404, detail="Chat session not found")

    return {
        "message": "Chat session and message history deleted successfully",
        "id": chat_id
    }


@api_router.post("/chats/{chat_id}/messages", response_model=ChatMessageResponse, status_code=201, tags=["Chat Sessions"])
async def send_chat_message(
    chat_id: str,
    payload: SendMessageRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Appends a user message to the session, retrieves history, invokes Gemini
    with full conversational context, persists the assistant reply, and returns it.
    """
    chat = await get_chat_session(session=db, session_id=chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat session not found")

    # 1. Save user message to Neon PostgreSQL
    user_msg = await add_chat_message(
        session=db,
        session_id=chat_id,
        role="user",
        content=payload.content
    )

    # 2. Build multi-turn context from prior history
    history = await get_chat_history(session=db, session_id=chat_id)

    # 3. Call Gemini via official google-genai client
    api_key = os.getenv("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})

    gemini_contents = []
    for msg in history:
        # Gemini expects 'user' or 'model'
        genai_role = "user" if msg.role == "user" else "model"
        gemini_contents.append(
            types.Content(
                role=genai_role,
                parts=[types.Part.from_text(text=msg.content)]
            )
        )

    config_kwargs = {}
    if chat.system_prompt:
        config_kwargs["system_instruction"] = chat.system_prompt

    try:
        response = client.models.generate_content(
            model=chat.model_name or "gemini-2.5-flash",
            contents=gemini_contents,
            config=types.GenerateContentConfig(**config_kwargs) if config_kwargs else None
        )
        reply_text = response.text or "I have processed your message."
    except Exception as e:
        reply_text = f"Error generating response: {str(e)}"

    # 4. Save assistant message to Neon PostgreSQL
    assistant_msg = await add_chat_message(
        session=db,
        session_id=chat_id,
        role="assistant",
        content=reply_text
    )

    return ChatMessageResponse(
        id=assistant_msg.id,
        session_id=assistant_msg.session_id,
        role=assistant_msg.role,
        content=assistant_msg.content,
        metadata_json=assistant_msg.metadata_json or {},
        created_at=assistant_msg.created_at.isoformat()
    )