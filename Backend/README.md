# Cloud-Native AI Coding Harness (Backend Engine)

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.163%2B-009688.svg)](https://fastapi.tiangolo.com/)
[![Docker Engine SDK](https://img.shields.io/badge/Docker-Engine%20SDK-2496ED.svg)](https://docker-py.readthedocs.io/)
[![Neon Database](https://img.shields.io/badge/Neon-Serverless%20PostgreSQL-00E599.svg)](https://neon.tech/)
[![Google Gemini 2.5](https://img.shields.io/badge/Google%20GenAI-Gemini%202.5%20Flash-4285F4.svg)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An enterprise-grade, cloud-native autonomous coding agent harness designed to orchestrate isolated cloud sandboxes, execute closed-loop ReAct reasoning cycles, persist relational state to **Neon Serverless PostgreSQL**, archive patch diffs to **Neon S3 Object Storage**, and stream live telemetry via full-duplex WebSockets.

---

## Table of Contents

- [Architectural Overview](#architectural-overview)
- [Core Engineering Pillars](#core-engineering-pillars)
- [System Architecture & Dataflow](#system-architecture--dataflow)
- [Directory Layout](#directory-layout)
- [Prerequisites & System Guardrails](#prerequisites--system-guardrails)
- [Installation & Setup](#installation--setup)
- [Running the Backend](#running-the-backend)
- [API Reference](#api-reference)
  - [System Health](#system-health)
  - [Autonomous Agent Runs](#autonomous-agent-runs)
  - [Real-Time WebSocket Streaming](#real-time-websocket-streaming)
  - [Multi-Turn Chat Sessions](#multi-turn-chat-sessions)
- [Sandbox Security & Cgroup Controls](#sandbox-security--cgroup-controls)
- [Autonomous Janitor Reaper](#autonomous-janitor-reaper)
- [Defect Tracking & Issues Matrix](#defect-tracking--issues-matrix)

---

## Architectural Overview

Traditional agent prototypes run arbitrary commands directly on the host or suffer from 30+ second container boot delays. This harness solves the fundamental isolation-latency-concurrency trilemma through:

1. **Sub-Second Sandbox Initialization ($<800\text{ms}$)**: Uses prebuilt cached base images (`cloud-native-sandbox:latest`) with `git` and toolchains pre-installed, bypassing runtime `apt-get` delays.
2. **Strict Hardware Envelopes**: Cgroups memory ceilings (`512MB`), single CPU pinning (`1.0 CPU`), PID ceilings (`64`), and complete Linux capability stripping (`cap_drop=["ALL"]`).
3. **Autonomous ReAct State Machine**: Executes closed-loop **Observe $\to$ Reason $\to$ Act $\to$ Evaluate** cycles against target codebases to identify bugs, apply surgical edits, execute unit tests, and extract unified git patch diffs.
4. **Cloud-Native Dual-Tier Persistence**:
   - **Neon Serverless PostgreSQL**: Relational tracking for projects, agent runs, chronological execution traces, and conversational chat threads.
   - **Neon S3-Compatible Object Storage**: High-durability storage bucket (`agent-artifacts`) for unified patch files (`.diff`) and raw execution logs.
5. **Full-Duplex Telemetry Streaming**: Event-driven WebSockets emitting structured reasoning thoughts, tool calls, and stdout/stderr chunks in real time.

---

## System Architecture & Dataflow

```
                           +----------------------------------+
                           |   Next.js Control Plane (Web)    |
                           +-----------------+----------------+
                                             |
                   HTTP POST /api/runs       |  WS /api/runs/{id}/stream
                   HTTP /api/chats           |  (Live reasoning, tool calls)
                                             v
                      +---------------------------------------+
                      |       FastAPI Gateway (Uvicorn)       |
                      |  - ConnectionManager (WebSockets)     |
                      |  - Async Background Worker Pool       |
                      +-------+-----------------------+-------+
                              |                       |
               CRUD Relational|                       | S3 Uploads
                              v                       v
               +----------------------+      +----------------------+
               | Neon PostgreSQL      |      | Neon Object Storage  |
               | - projects           |      | - runs/{id}/patch.diff
               | - agent_runs         |      | - runs/{id}/run.log  |
               | - execution_steps    |      +----------------------+
               | - chat_sessions      |
               | - chat_messages      |
               +----------------------+
                              ^
                              | Execution Traces & Metrics
                              |
       +----------------------+-----------------------+
       |           Harness ReAct Engine               |
       |  - LLMClient (Google Gemini 2.5 Flash)       |
       |  - ExecuteTools (Defensive Input Dispatcher) |
       +----------------------+-----------------------+
                              |
                              | Docker Engine SDK (Isolated Exec)
                              v
       +----------------------------------------------+
       |         Linux Sandbox (Docker)               |
       |  Container: agent-sandbox-{uuid}             |
       |  Volume:    agent-workspace-{uuid}           |
       |  Limits:    512MB RAM | 1 CPU | 64 PIDs      |
       +----------------------------------------------+
```

---

## Directory Layout

```text
Backend/
├── Dockerfile                   # Prebuilt sandbox image (python:3.12-slim + git)
├── requirements.txt             # Locked Python production dependencies
├── .env.example                 # Environment variables specification
├── .env                         # Local runtime credentials (ignored by git)
├── brain/                       # Application Core & Lifecycle
│   ├── __init__.py              # Package exports (app)
│   └── _main.py                 # FastAPI application, CORS, init_db, Janitor Reaper
├── controller/                  # API Gateway & Real-Time Dispatcher
│   ├── __init__.py              # Package exports (api_router)
│   ├── _route.py                # Forwarding router alias
│   └── _routes.py               # REST endpoints, WebSocket manager, Chat API
├── DB/                          # Cloud Persistence Layer (Neon)
│   ├── __init__.py              # Unified database models & CRUD exports
│   ├── _projects.py             # SQLAlchemy models (Project, AgentRun, ExecutionStep)
│   ├── _chat.py                 # Chat models (ChatSession, ChatMessage) & CRUD
│   └── _object_storage.py       # Boto3 client for Neon S3 Object Storage
├── Harness/                     # Agent Cognition & Orchestration
│   ├── __init__.py
│   ├── _agent_loop.py           # Autonomous ReAct state machine with event callbacks
│   ├── _LLM_client.py           # Gemini 2.5 Flash client with tool specifications
│   ├── _tools.py                # JSON tool definitions (read, create, run, diff)
│   └── _execute_tools.py        # Defensive dispatcher with input validation boundaries
└── Sandbox/                     # Container Execution Layer
    ├── __init__.py
    ├── _sandbox_setup.py        # Lazy Docker client, dynamic sandboxes, cgroups limits
    └── _sandbox_executor.py     # Base64 file I/O, streaming commands, unified diffs
```

---

## Prerequisites & System Guardrails

### 1. Docker Desktop
Ensure Docker Desktop is installed and running in **Linux containers mode**.

### 2. Host RAM Guardrails (Windows WSL2)
To protect a 16GB host machine from memory exhaustion during multi-agent concurrency, create or update `C:\Users\<YourUser>\.wslconfig`:

```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
```
Restart WSL via PowerShell: `wsl --shutdown`.

### 3. Neon Cloud Accounts & API Keys
- A [Neon](https://neon.tech/) project with PostgreSQL and Object Storage enabled.
- A [Google AI Studio](https://aistudio.google.com/) Gemini API key.

---

## Installation & Setup

### 1. Create Virtual Environment
Using [uv](https://github.com/astral-sh/uv) (recommended) or standard Python:

```powershell
cd D:\Complex_backend\Cloud_native\Backend
uv venv .venv --python 3.12
.\.venv\Scripts\activate
```

### 2. Install Dependencies
```powershell
uv pip install -r requirements.txt
```

### 3. Configure Environment Variables
Create `Backend/.env` matching `.env.example`:

```env
# Server
ENV=development
PORT=8000

# AI Provider
GEMINI_API_KEY=your_gemini_api_key_here
DEFAULT_MODEL=gemini-2.5-flash

# Neon Serverless PostgreSQL
DATABASE_URL=postgresql+asyncpg://<user>:<password>@<neon-host>/neondb?ssl=require

# Neon S3 Object Storage
AWS_REGION=us-east-2
AWS_ENDPOINT_URL_S3=https://<neon-branch-id>.storage.c-9.us-east-2.aws.neon.tech
AWS_ACCESS_KEY_ID=your_neon_storage_access_key
AWS_SECRET_ACCESS_KEY=your_neon_storage_secret_key
NEON_STORAGE_BUCKET=agent-artifacts
```

### 4. Build Prebuilt Sandbox Image
To guarantee sub-second startup times ($<800\text{ms}$) and prevent runtime `git` missing errors:

```powershell
docker build -t cloud-native-sandbox:latest -f Dockerfile .
```

---

## Running the Backend

Launch the FastAPI Gateway with auto-reload:

```powershell
cd D:\Complex_backend\Cloud_native\Backend
& .\.venv\Scripts\python.exe -m uvicorn brain._main:app --host 0.0.0.0 --port 8000 --reload
```

Upon boot, the server will:
1. Verify connectivity with Neon S3 Object Storage (`agent-artifacts`).
2. Run database migrations to ensure all relational tables exist in Neon.
3. Start the background **Janitor Reaper** service.
4. Expose Swagger UI at: **`http://127.0.0.1:8000/docs`**

---

## API Reference

### System Health
- `GET /health`: Returns service heartbeat and UTC timestamp.

### Autonomous Agent Runs
- `POST /api/runs`: Spawns a background ReAct loop in a new Docker sandbox.
  ```json
  {
    "task_prompt": "Fix ZeroDivisionError in src/calculator.py and run unit tests",
    "model_name": "gemini-2.5-flash",
    "max_iterations": 12
  }
  ```
- `GET /api/runs`: Lists recent runs with status (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`).
- `GET /api/runs/{run_id}`: Fetches run details and every step in the agent's execution history.
- `GET /api/runs/{run_id}/diff`: Downloads the patch diff from Neon S3 Object Storage.

### Real-Time WebSocket Streaming
- `WS /api/runs/{run_id}/stream`: Connect to stream live agent events:
  ```json
  {
    "event": "thought",
    "step": 1,
    "content": "Analyzing calculator.py..."
  }
  ```
  ```json
  {
    "event": "tool_execution",
    "step": 1,
    "tool": "read_file",
    "args": {"path": "src/calculator.py"},
    "result": {"status": "success", "content": "..."}
  }
  ```
  ```json
  {
    "event": "finish",
    "status": "COMPLETED",
    "summary": "Safely handled zero division in calculator.py",
    "diff": "--- a/src/calculator.py\n+++ b/src/calculator.py..."
  }
  ```

### Multi-Turn Chat Sessions
- `POST /api/chats`: Create a new conversation thread (`{"title": "Refactoring Auth"}`).
- `GET /api/chats`: List conversations ordered by latest activity (for sidebar).
- `GET /api/chats/{chat_id}`: Fetch conversation details and historical messages.
- `GET /api/chats/{chat_id}/history`: Fetch array of messages.
- `PATCH /api/chats/{chat_id}`: Update title or model (`{"title": "Updated Title"}`).
- `DELETE /api/chats/{chat_id}`: Cascade delete conversation and all messages.
- `POST /api/chats/{chat_id}/messages`: Send a message; Gemini responds with full multi-turn conversational memory.

---

## Sandbox Security & Cgroup Controls

Every agent execution is isolated in an ephemeral Linux container with defense-in-depth security:

| Parameter | Configuration | Security Purpose |
| :--- | :--- | :--- |
| **`mem_limit`** | `512m` | Prevents OOM memory bomb attacks on the host. |
| **`nano_cpus`** | `1_000_000_000` | Limits execution to 1 CPU core; prevents thread starvation. |
| **`pids_limit`** | `64` | Blocks fork bombs (`:(){ :|:& };:`). |
| **`cap_drop`** | `["ALL"]` | Strips all root Linux kernel capabilities. |
| **`network_disabled`** | `True` *(Optional)* | Enforces zero-egress for untrusted code execution. |

---

## Autonomous Janitor Reaper

To prevent zombie containers from leaking memory when jobs fail or time out:
- A background asyncio worker runs every **300 seconds** (5 minutes).
- It queries the Docker daemon for containers matching `agent-sandbox-*`.
- Any container older than **600 seconds** (10 minutes) is forcibly removed along with associated anonymous volumes (`c.remove(v=True, force=True)`).

---

## Defect Tracking & Issues Matrix

The codebase follows a strict empirical debugging lifecycle documented in [Backend/Issues.md](Issues.md). All engineering defects are categorized with root causes, remediations, and verification matrices:

| ID | Severity | Defect | Root Cause & Surgical Fix |
| :--- | :---: | :--- | :--- |
| **#001** | P1 | Image 404 Error | Corrected syntax from `python-3.12-slim` to standard `python:3.12-slim`. |
| **#002** | P2 | Missing `retry` Module | Installed `retry` and pinned dependencies in `requirements.txt`. |
| **#003** | P2 | Sibling Package Import Path | Converted imports to module resolution (`python -m Sandbox._sandbox_setup`). |
| **#004** | P1 | Missing Tool Contract File | Created `Backend/Harness/_tools.py` with typed function definitions. |
| **#005** | P2 | Unsafe Tuple Unpacking | Added null-coalescing guard around `exec_result.output` in `_sandbox_executor.py`. |
| **#006** | P2 | Missing Argument Validation | Added parameter boundary assertions before container dispatch in `_execute_tools.py`. |
| **#007** | P3 | Missing `git` in Base Image | Built custom `Dockerfile` provisioning `cloud-native-sandbox:latest`. |
| **#008** | P1 | Eager Docker Client at Boot | Replaced top-level `docker.from_env()` with lazy `get_docker_client()` connection. |

---

## License

Distributed under the MIT License. See `LICENSE` for more information.
