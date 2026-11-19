# Cloud-Native AI Coding Harness: Architecture & Implementation Plan

> **Goal:** Build an enterprise-grade, cloud-native AI coding agent harness that safely executes autonomous agent loops (observe $\rightarrow$ reason $\rightarrow$ tool call $\rightarrow$ test $\rightarrow$ patch) inside isolated Docker sandboxes with a real-time streaming Next.js control plane.

---

## 1. System Architecture Overview

```text
                     ┌────────────────────────────────────────────────────────┐
                     │          Next.js Control Plane (React 19)              │
                     │  - Live Agent Reasoning Stream (SSE / WebSocket)       │
                     │  - Interactive Terminal Output (xterm.js)              │
                     │  - Git Diff & Patch Viewer (Monaco / Diff)             │
                     │  - Active Sandbox Resource Monitor (CPU/RAM)           │
                     └───────────────────────────┬────────────────────────────┘
                                                 │ HTTP / WebSocket
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FastAPI Backend Core (Python 3.11+)                                         │
│                                                                             │
│   brain/               controller/                 DB/ (Neon & S3)          │
│   ├── _main.py  ◄──────├── _route.py        ┌──────├── _projects.py (Neon)  │
│   (Lifecycle &         (REST + Streaming)   │      └── _object_storage.py   │
│    Background Reaper)          │            │          (R2 / S3 Storage)    │
│                                ▼            │                               │
│                        harness/             │ (Run Traces, Diff Patches)    │
│                        ├── _agent_loop.py ──┘                               │
│                        ├── _LLM_client.py   (Gemini 2.5/3 / Claude / GPT)   │
│                        ├── _tools.py        (Pydantic Tool Schemas)         │
│                        └── _execute_tools.py                                │
│                                │                                            │
│                                ▼ (Guarded Dispatch)                         │
│                        sandbox/                                             │
│                        ├── _sandbox_setup.py    (Cgroups, Quotas, Pool)     │
│                        └── _sandbox_executor.py (Base64/Tar I/O, Exec)      │
└────────────────────────────────┼────────────────────────────────────────────┘
                                 │ Docker Engine API (/var/run/docker.sock)
                                 ▼
         ┌───────────────────────────────────────────────────────────┐
         │ Ephemeral Docker Sandboxes (Local: 3-5 Max | Cloud: 100+) │
         │  - cgroups: 512MB RAM, 1 CPU, 64 PIDs limit               │
         │  - Security: cap_drop=["ALL"], no-new-privileges          │
         │  - Storage: Ephemeral tmpfs / Unique UUID Named Volumes   │
         └───────────────────────────────────────────────────────────┘
```

---

## 2. Local PC Safety & Resource Guardrails (16 GB RAM Hard Limits)

To ensure your local development machine (Intel i7-1065G7, 16 GB RAM, ~3.9 GB currently free, 13 GB free on `C:`, 163 GB free on `D:`) **never freezes, locks up, or exhausts disk/inodes**, the architecture strictly enforces the following guardrails:

### Guardrail 1: Local Concurrency Semaphore
* **Local Limit:** Capped at **3 concurrent sandboxes by default** (configurable up to 5 via `.env`).
* **Mechanism:** An `asyncio.Semaphore(MAX_CONCURRENT_SANDBOXES)` wraps container creation. If a 4th agent request arrives, it waits in an in-memory queue rather than crashing the Docker daemon.

### Guardrail 2: Container Resource Hard Caps
* **Memory Limit:** `512m` hard ceiling per sandbox. Even 5 concurrent sandboxes use at most $5 \times 512\text{ MB} = 2.56\text{ GB}$ RAM, safely below your available free memory.
* **CPU Limit:** `nano_cpus=1_000_000_000` (1 core maximum).
* **PID Limit:** `pids_limit=64` (immediate fork bomb protection).
* **Execution Timeout:** Max execution duration of 180 seconds per command and 10 minutes per total sandbox session.

### Guardrail 3: Drive & Storage Hygiene (Protecting the 13 GB `C:` Drive)
* **Project Directory:** Kept entirely on `D:\Complex_backend\Cloud_native` (163 GB free).
* **Zero Orphaned Volumes:** Every container is destroyed with `container.remove(force=True, v=True)`.
* **RAM Filesystems (`tmpfs`):** Workspaces use in-memory `tmpfs` mounts when possible, avoiding host disk writes entirely.
* **Auto-Janitor Process:** A background asyncio task in `brain/_main.py` scans every 5 minutes to auto-prune any orphaned containers or unattached volumes whose TTL has expired.

### Guardrail 4: WSL2 Memory Configuration (One-time Setup)
To prevent WSL2 / Docker Desktop from consuming all 16 GB of host RAM, create `C:\Users\Asus\.wslconfig`:
```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
```

---

## 3. Existing Baseline Code vs. Hardened Production Plan

The project directly integrates and hardens the existing prototype code snippets:

### Baseline 1: Sandbox Lifecycle (`backend/sandbox/_sandbox_setup.py`)

#### Existing Prototype Code:
```python
def create_sandbox():
    container = client.containers.run(
        image="python:3.12-slim",
        command="sleep infinity",
        detach=True,
        working_dir="/workspace",
        network_disabled=True,
        mem_limit="512m",
        nano_cpus=1_000_000_000,
        pids_limit=64,
        cap_drop=["ALL"],
        security_opt=["no-new-privileges"],
        volumes={
            "agent-workspace": {
                "bind": "/workspace",
                "mode": "rw"
            }
        }
    )
    return container

def destroy_sandbox(container):
    try:
        container.remove(force=True)
        # client.volumes.get("agent-workspace").remove()
    except Exception as E:
        print(f"Error occured while destroying sandbox: {E}")
```

#### Production Upgrades in this Plan:
1. **Dynamic Sandbox & Volume IDs:**
   * *Problem in prototype:* Hardcoding `"agent-workspace"` causes collision when $>1$ agent runs concurrently.
   * *Production Fix:* Generate unique names per run: `sandbox_id = f"sandbox-{uuid4().hex[:8]}"` and `volume_name = f"vol-{sandbox_id}"`.
2. **Guaranteed Volume & Storage Teardown:**
   * *Problem in prototype:* `# client.volumes.get(...).remove()` is commented out, causing disk storage and inode leakage.
   * *Production Fix:* Use `container.remove(force=True, v=True)` so Docker automatically deletes attached anonymous volumes, and explicitly remove named volumes in a `finally:` block.
3. **Pre-Warmed Pool for `< 5s` Startup:**
   * *Problem in prototype:* Calling `client.containers.run()` cold on every request can take 4–10 seconds.
   * *Production Fix:* Implement `SandboxPool` that keeps 2 idle pre-spawned containers on standby ready for instant checkout ($\le 0.5\text{s}$ startup).
4. **Network Policy for Package Installation:**
   * *Problem in prototype:* `network_disabled=True` prevents `pip install` or downloading fixtures.
   * *Production Fix:* Configurable network mode: air-gapped by default, but supports pre-warmed virtual environments or controlled outbound proxy when package installations are explicitly required.

---

### Baseline 2: Sandbox File I/O & Execution (`backend/sandbox/_sandbox_executor.py`)

#### Existing Prototype Code:
```python
def create_file(container, path, content):
    encoded = base64.b64encode(content.encode()).decode()
    quoted_path = shlex.quote(path)
    command = (
        f'mkdir -p "$(dirname {quoted_path})" && '
        f'printf %s {shlex.quote(encoded)} | '
        f'base64 -d > {quoted_path}'
    )
    return run_command(container, command)

def read_file(container, path):
    return run_command(
        container,
        f"cat {shlex.quote(path)}"
    )
```

#### Production Upgrades in this Plan:
1. **Real-Time Streaming `run_command`:**
   * *Problem in prototype:* `run_command` is a blocking call that returns only when the process finishes.
   * *Production Fix:* Upgrade to an asynchronous streaming generator using `container.exec_run(..., stream=True)` that yields chunks of terminal `stdout`/`stderr` live to WebSockets / SSE.
2. **Large File Handling (Docker Archive API fallback):**
   * *Problem in prototype:* Linux kernel argument limits (`ARG_MAX` ~2MB) cause `printf %s {base64}` to fail on large files.
   * *Production Fix:* For files $>1\text{ MB}$, stream content directly into the container using Docker’s native `put_archive()` (tar stream), avoiding shell limits entirely.
3. **Execution Guardrails & Timeouts:**
   * *Problem in prototype:* An infinite loop (e.g. `while True:`) inside the container hangs the thread forever.
   * *Production Fix:* Wrap executions with strict timeouts (`asyncio.wait_for(..., timeout=120)`) and auto-kill stalled processes.
4. **Git Diff & Patch Extractor:**
   * *Production Addition:* Implement `get_git_diff(container)` to automatically generate standard `.patch` unified diffs after code edits.

---

## 4. Technology Stack Specification

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **Backend Framework** | **FastAPI + Uvicorn** (Python 3.11+) | Async native, high-performance WebSockets/SSE streaming, automated OpenAPI docs. |
| **Data Validation** | **Pydantic v2** | Strict schema validation for tool calls, API requests, and agent states. |
| **Database** | **Neon (Serverless PostgreSQL)** | Instant provisioning, connection pooling via PgBouncer, auto-scaling, modern SQL. |
| **ORM / Migration** | **SQLAlchemy 2.0 (asyncio) + Alembic** | Type-safe async database queries and automated schema migrations. |
| **Object Storage** | **Cloudflare R2 / AWS S3 / Supabase** | High-throughput, low-cost storage for repo archives, git patches/diffs, and full execution logs. |
| **AI LLM Client** | **Google Gemini 2.5 Flash / Pro** | Large context window (1M+ tokens), fast reasoning, low latency, native tool calling. |
| **Container Engine** | **Docker Engine SDK (`docker`)** | Full programmatic control over sandbox lifecycles, cgroups, and execution pipes. |
| **Frontend Framework** | **Next.js 15 (App Router, TypeScript)** | Modern React server components, TailwindCSS, Lucide icons, fast SSR/CSR balance. |
| **Frontend UI Tools** | **Monaco Editor / Diff2Html + xterm.js** | Production-grade terminal emulation and side-by-side git diff inspection. |

---

## 5. Directory Structure & File Responsibilities

```text
Cloud_native/
├── plan.md                                # This architecture & execution blueprint
├── .env.example                           # Environment configuration template
├── .gitignore
├── backend/
│   ├── requirements.txt                   # Backend dependencies
│   ├── brain/
│   │   ├── __init__.py
│   │   └── _main.py                       # FastAPI application entrypoint & startup/shutdown events
│   ├── controller/
│   │   ├── __init__.py
│   │   └── _route.py                      # REST endpoints & WebSocket / SSE streaming handlers
│   ├── DB/
│   │   ├── __init__.py
│   │   ├── _projects.py                   # Neon PostgreSQL connection, models, and CRUD operations
│   │   └── _object_storage.py             # S3 / R2 storage client for diffs, patches, and logs
│   ├── harness/
│   │   ├── __init__.py
│   │   ├── _agent_loop.py                 # Autonomous ReAct state machine (Observe-Reason-Act)
│   │   ├── _LLM_client.py                 # Multi-provider LLM caller with function-calling support
│   │   ├── _tools.py                      # JSON & Pydantic declarations of agent tools
│   │   └── _execute_tools.py              # Dispatches agent tool calls to the sandbox layer
│   └── sandbox/
│       ├── __init__.py
│       ├── _sandbox_setup.py              # Upgraded create_sandbox, destroy_sandbox & pool manager
│       └── _sandbox_executor.py           # Upgraded create_file, read_file, streaming run_command & diff
└── frontend/                              # Next.js Control Plane
    ├── package.json
    ├── tsconfig.json
    ├── tailwind.config.ts
    ├── src/
    │   ├── app/
    │   │   ├── layout.tsx
    │   │   ├── page.tsx                   # Main Dashboard (Runs, Agents, Live Stream)
    │   │   └── runs/[id]/page.tsx         # Detailed Run View (Traces, Terminal, Diff)
    │   ├── components/
    │   │   ├── AgentTraces.tsx            # Streaming step-by-step reasoning feed
    │   │   ├── TerminalViewer.tsx         # xterm.js live stdout/stderr terminal
    │   │   ├── DiffViewer.tsx             # Monaco / Diff2Html viewer for patch files
    │   │   ├── SandboxMetrics.tsx         # Active sandboxes, RAM, and CPU gauges
    │   │   └── TaskLauncher.tsx           # Form to launch autonomous coding tasks
    │   └── lib/
    │       ├── api.ts                     # REST API client
    │       └── useStream.ts               # Custom WebSocket / SSE hook for real-time data
```

---

## 6. Database Schema (Neon PostgreSQL)

```sql
-- Projects Table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    repo_url TEXT NOT NULL,
    default_branch VARCHAR(100) DEFAULT 'main',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Agent Runs Table
CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    task_prompt TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, RUNNING, COMPLETED, FAILED, TIMED_OUT
    model_name VARCHAR(100) DEFAULT 'gemini-2.5-flash',
    patch_storage_key TEXT,               -- Pointer to S3/R2 patch file
    log_storage_key TEXT,                 -- Pointer to S3/R2 raw terminal log
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Execution Steps (Traces) Table
CREATE TABLE execution_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_number INT NOT NULL,
    step_type VARCHAR(50) NOT NULL,       -- THOUGHT, TOOL_CALL, TOOL_RESULT, ERROR, SYSTEM
    content JSONB NOT NULL,               -- Reasoning text, tool name, arguments, output
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sandbox Tracking Table
CREATE TABLE sandboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    container_id VARCHAR(128) NOT NULL,
    volume_id VARCHAR(128),
    status VARCHAR(50) DEFAULT 'ACTIVE',  -- ACTIVE, TERMINATED, REAPED
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    terminated_at TIMESTAMP WITH TIME ZONE
);
```

---

## 7. Detailed Implementation Phases

### Phase 1: Environment & Guardrail Setup
* [ ] Create `.wslconfig` on Windows host to cap WSL2 memory at 6 GB.
* [ ] Verify Docker Desktop connectivity on Windows with Python.
* [ ] Initialize backend Python virtual environment (`venv`) on `D:` drive.
* [ ] Install core dependencies (`fastapi`, `uvicorn`, `docker`, `sqlalchemy`, `asyncpg`, `boto3`, `pydantic`).
* [ ] Configure Neon PostgreSQL connection string and test database migrations.

### Phase 2: Sandbox Engine Implementation (`sandbox/`)
* [ ] Build `_sandbox_setup.py`:
  * Integrate baseline `create_sandbox` with dynamic UUIDs (`f"agent-sandbox-{uuid4()[:8]}"`).
  * Enforce resource limits: `mem_limit="512m"`, `nano_cpus=1_000_000_000`, `pids_limit=64`.
  * Safe teardown function: `container.remove(force=True, v=True)`.
  * Pre-warmed sandbox pool manager (maintains 2 standby containers for instantaneous startup).
* [ ] Build `_sandbox_executor.py`:
  * Integrate baseline `create_file(container, path, content)` (Base64 encoding + directory creation) with tar stream fallback.
  * Integrate baseline `read_file(container, path)` with safe path quoting and size checks.
  * Build streaming `run_command(container, cmd, timeout=120)` with stdout/stderr async generator.
  * Build `get_git_diff(container)`: Generates patch files for completed fixes.
* [ ] Write unit tests verifying container startup, command execution, and cleanup.

### Phase 3: DB & Storage Integration (`DB/`)
* [ ] Implement `_projects.py`: Async SQLAlchemy models and CRUD operations for projects, runs, and execution steps.
* [ ] Implement `_object_storage.py`: Asynchronous upload/download for patch files, logs, and git bundles to S3/R2.

### Phase 4: Agent Cognition & Harness (`harness/`)
* [ ] Build `_tools.py`: Define JSON and Pydantic schemas for agent capabilities:
  * `read_file`, `create_file`, `edit_file`, `list_directory`, `run_terminal_command`, `finish_task`.
* [ ] Build `_LLM_client.py`: Multi-provider abstraction calling Gemini/OpenAI with function calling.
* [ ] Build `_execute_tools.py`: Connect tool invocations to `_sandbox_executor.py` methods with error boundary handling.
* [ ] Build `_agent_loop.py`:
  * Initialize task prompt and clone/mount target repository.
  * Run step loop (up to max 25 iterations).
  * Stream each thought, tool call, and tool result via an async event generator.
  * Finalize run by generating a git patch and uploading to Object Storage.

### Phase 5: FastAPI Controller & Real-Time API (`controller/` & `brain/`)
* [ ] Build `_route.py`:
  * `POST /api/runs`: Launch a new coding task.
  * `GET /api/runs/{id}`: Fetch run details and status.
  * `GET /api/runs/{id}/diff`: Download or inspect the generated git patch.
  * `WebSocket /api/runs/{id}/stream`: Real-time duplex channel streaming agent thoughts, tool logs, and terminal output.
* [ ] Build `brain/_main.py`:
  * App lifecycle management.
  * Async background reaper task: runs every 5 minutes to clean up expired/orphaned containers.
  * Global exception handling and CORS setup.

### Phase 6: Next.js Real-Time Control Plane (`frontend/`)
* [ ] Initialize Next.js project with TailwindCSS and Lucide icons.
* [ ] Build Dashboard components:
  * `TaskLauncher`: Input repository URL and task description (e.g. "Fix unit test in test_auth.py").
  * `AgentTraces`: Chronological streaming feed of agent thoughts and tool calls.
  * `TerminalViewer`: Live terminal showing in-container command outputs.
  * `DiffViewer`: Side-by-side visual diff of the changes proposed by the agent.
  * `SandboxMetrics`: Shows currently running sandboxes and memory usage.

### Phase 7: Verification, Load Testing & Resume Demonstration
* [ ] Run end-to-end test on a real open-source Python repo (e.g. fix a broken pytest test).
* [ ] Test concurrency guardrails: Launch 5 parallel agent runs simultaneously to verify the local semaphore prevents host slowdown.
* [ ] Record a 60-second video demo showcasing the Next.js control plane streaming live agent reasoning and terminal output from an isolated container.

---

## 8. Configuration Defaults (`.env.example`)

```env
# Application Settings
ENV=development
PORT=8000
MAX_CONCURRENT_SANDBOXES=3
SANDBOX_MEMORY_LIMIT=512m
SANDBOX_CPU_LIMIT=1.0
SANDBOX_TIMEOUT_SECONDS=600

# AI Provider
GEMINI_API_KEY=your_gemini_api_key_here
DEFAULT_MODEL=gemini-2.5-flash

# Database (Neon PostgreSQL)
DATABASE_URL=postgresql+asyncpg://user:password@ep-sample-pooler.us-east-2.aws.neon.tech/neondb?ssl=require

# Object Storage (S3 / Cloudflare R2)
STORAGE_ENDPOINT_URL=https://<account_id>.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=your_access_key
STORAGE_SECRET_ACCESS_KEY=your_secret_key
STORAGE_BUCKET_NAME=agent-artifacts
```
