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
from typing import Any
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from rich.console import Console

from DB._projects import (
    get_db,
    create_agent_run,
    record_execution_step,
    finalize_agent_run,
    AgentRun,
    ExecutionStep,
    AsyncSessionLocal,
)
from DB._object_storage import NeonObjectStorage
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
        console.print(f"[bold red]Background run {run_id} failed: {e}[/bold red]")
        async def _record_failure():
            async with AsyncSessionLocal() as session:
                await finalize_agent_run(
                    session=session,
                    run_id=run_id,
                    status="FAILED",
                    summary=f"Execution error: {str(e)}"
                )
            await manager.broadcast(run_id, {
                "event": "finish",
                "status": "FAILED",
                "summary": f"Execution failed: {str(e)}"
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
async def get_run_diff(run_id: str):
    """Downloads the generated patch file from Neon Object Storage."""
    diff_text = storage.download_patch(run_id)
    if not diff_text:
        raise HTTPException(status_code=404, detail="No patch found for this run.")
    return {"run_id": run_id, "patch": diff_text}


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