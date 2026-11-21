"""
Application Entrypoint & Background Janitor Service
----------------------------------------------------
Bootstraps FastAPI with:
  1. Neon PostgreSQL schema initialization.
  2. CORS middleware configured for Next.js control plane (localhost:3000).
  3. API router endpoints.
  4. Janitor Reaper background task: Automatically destroys orphan Docker
     sandboxes exceeding a 10-minute TTL to safeguard local RAM and CPU.
"""

import asyncio
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import docker
from rich.console import Console

from DB._projects import init_db
from controller._routes import api_router

console = Console()


async def janitor_reaper(interval_seconds: int = 300, max_age_seconds: int = 600):
    """
    Background Janitor Service.
    Runs every 5 minutes to detect and reap zombie/orphaned 'agent-sandbox-*'
    containers running longer than max_age_seconds.
    """
    client = docker.from_env()
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            console.print("[dim cyan]Janitor Reaper: Scanning for expired sandboxes...[/dim cyan]")

            containers = client.containers.list(all=True)
            reaped_count = 0

            for c in containers:
                if c.name and c.name.startswith("agent-sandbox-"):
                    created_str = c.attrs.get("Created", "")[:19]
                    try:
                        created_time = datetime.fromisoformat(created_str).replace(tzinfo=timezone.utc)
                        age = (datetime.now(timezone.utc) - created_time).total_seconds()
                        if age > max_age_seconds:
                            console.print(f"[bold yellow]Janitor Reaper: Killing zombie sandbox {c.name} (Age: {int(age)}s)[/bold yellow]")
                            c.remove(v=True, force=True)
                            reaped_count += 1
                    except Exception as parse_err:
                        console.print(f"[yellow]Failed to check container {c.name}: {parse_err}[/yellow]")

            if reaped_count > 0:
                console.print(f"[bold green]Janitor Reaper: Cleaned up {reaped_count} expired sandbox(es).[/bold green]")
        except asyncio.CancelledError:
            console.print("[dim yellow]Janitor Reaper stopped.[/dim yellow]")
            break
        except Exception as err:
            console.print(f"[red]Janitor Reaper error: {err}[/red]")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager: runs on startup and graceful shutdown."""
    console.rule("[bold magenta]Cloud-Native AI Harness API Starting")

    # 1. Ensure database tables exist in Neon
    await init_db()

    # 2. Launch background container reaper task
    reaper_task = asyncio.create_task(janitor_reaper(interval_seconds=300, max_age_seconds=600))
    console.print("[green]✔ Janitor Reaper background service activated.[/green]")

    yield

    # Shutdown sequence
    reaper_task.cancel()
    try:
        await reaper_task
    except asyncio.CancelledError:
        pass
    console.rule("[bold yellow]Cloud-Native AI Harness API Shutdown Complete")


# Create FastAPI application
app = FastAPI(
    title="Cloud-Native AI Coding Harness",
    description="Autonomous ReAct sandbox orchestration and real-time execution streaming.",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for Next.js control plane
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register Controller routes
app.include_router(api_router)


@app.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint to verify API and server status."""
    return {
        "status": "healthy",
        "service": "cloud-native-harness",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("brain._main:app", host="0.0.0.0", port=8000, reload=True)
