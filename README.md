# Cloud-Native AI Coding Harness

An enterprise-grade, cloud-native autonomous coding agent harness designed to orchestrate 100+ isolated cloud sandboxes, execute closed-loop ReAct reasoning cycles, persist relational state to **Neon Serverless PostgreSQL**, archive patch diffs to **Neon S3 Object Storage**, and stream live telemetry to a **Next.js Real-Time Control Plane**.

---

## Monorepo Architecture

```text
Cloud_native/
├── Backend/                     # FastAPI Gateway, Docker Sandbox Engine & ReAct Harness
│   ├── brain/                   # Entrypoint, CORS, init_db, Janitor Reaper
│   ├── controller/              # REST Endpoints, WebSocket Streaming & Chat Sessions
│   ├── DB/                      # Neon PostgreSQL (SQLAlchemy Async) & Neon S3 (Boto3)
│   ├── Harness/                 # Gemini 2.5 Flash ReAct State Machine & Tool Dispatcher
│   ├── Sandbox/                 # Docker SDK Sandbox Engine (Cgroups, Caps, File I/O)
│   ├── Dockerfile               # Prebuilt sandbox image (cloud-native-sandbox:latest)
│   ├── requirements.txt         # Python dependencies
│   └── README.md                # Comprehensive Backend Technical Documentation
│
├── frentend/                    # Next.js 16 Real-Time Control Plane (App Router)
│   ├── app/                     # Next.js layout, pages, and components
│   ├── package.json             # Bun / Next.js dependencies (TailwindCSS v4, React 19)
│   └── README.md
│
└── .gitignore                   # Global ignore rules for secrets, virtualenvs, and builds
```

---

## Quick Navigation

- 📖 **[Backend Documentation & Setup Guide](Backend/README.md)**: Full API reference, Docker cgroup limits, Neon database models, and local startup instructions.
- 📐 **[Engineering Plan & Architecture Blueprint](Backend/plan.md)**: 7-phase roadmap detailing the system from environment setup to load testing.
- 🛠 **[Defect Tracking & Issues Matrix](Backend/Issues.md)**: Root-cause analysis reports for Issues #001 through #008.

---

## Key Features

1. **Sub-Second Sandbox Spin-up ($<800\text{ms}$)**: Docker sandboxes launch instantly with prebuilt base images and volume caching.
2. **Strict Host Protections**: 512MB RAM cap, 1 CPU limit, 64 PIDs ceiling, and stripped Linux capabilities.
3. **Autonomous ReAct Engine**: Closed-loop Observe $\to$ Reason $\to$ Act $\to$ Evaluate cycle solving bugs and running unit tests inside Docker.
4. **Neon Dual-Tier Cloud Persistence**:
   - Serverless PostgreSQL for runs, traces, and multi-turn chat sessions.
   - S3-compatible Object Storage for patch diffs and execution logs.
5. **Real-Time Streaming**: Full-duplex WebSockets pushing agent thoughts, tool executions, and terminal logs directly to the frontend.

---

## Getting Started

### 1. Launch the Backend
```powershell
cd Backend
uv venv .venv --python 3.12
.\.venv\Scripts\activate
uv pip install -r requirements.txt
& .\.venv\Scripts\python.exe -m uvicorn brain._main:app --port 8000 --reload
```
Interactive API documentation: **`http://127.0.0.1:8000/docs`**

### 2. Launch the Frontend
```powershell
cd frentend
bun install
bun run dev
```
Control Plane UI: **`http://localhost:3000`**
