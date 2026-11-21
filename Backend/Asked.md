# Cloud-Native AI Coding Harness: Senior Technical Interview Guide (`Asked.md`)

> A comprehensive, battle-tested interview guide covering the **Approach, Architecture, Design Decisions, Systems Implementation, Database & Storage Tiers, and Problem-Solving Strategies** for this Cloud-Native AI Coding Agent Harness.

---

## Table of Contents
1. [Category 1: Approach & High-Level Philosophy](#category-1-approach--high-level-philosophy)
2. [Category 2: System Architecture & Concurrency at Scale (100+ Agents)](#category-2-system-architecture--concurrency-at-scale-100-agents)
3. [Category 3: Core Design Decisions & Engineering Trade-Offs](#category-3-core-design-decisions--engineering-trade-offs)
4. [Category 4: Linux Kernel & Container Security Implementation](#category-4-linux-kernel--container-security-implementation)
5. [Category 5: Cognitive Agent Loop & Tooling Failure Modes](#category-5-cognitive-agent-loop--tooling-failure-modes)
6. [Category 6: Cloud Persistence, Database & Object Storage (Neon)](#category-6-cloud-persistence-database--object-storage-neon)
7. [Category 7: Problem-Solving Strategies & Incident Debugging (Issues #001–#008)](#category-7-problem-solving-strategies--incident-debugging-issues-001008)

---

## Category 1: Approach & High-Level Philosophy

### Q1.1: "Why build a custom coding harness instead of just calling an LLM API directly from a web backend?"
* **What the interviewer is testing:** Do you understand the difference between a superficial "AI wrapper" and an autonomous software engineering execution engine?
* **Senior-Level Answer:**
  > *"A standard LLM API call is purely generative—it produces text in a vacuum without environmental feedback. Real software engineering requires an empirical loop: inspecting code, formulating hypotheses, editing files, running tests, and observing terminal output.*
  > 
  > *If you let an LLM execute code directly on your host or application server, you introduce catastrophic risks: accidental host deletion (`rm -rf`), runaway fork bombs, port scanning of internal networks, and state contamination between tasks.*
  > 
  > *Our harness decouples **Cognition (the LLM)** from **Execution (the Sandbox)**. It treats compute as ephemeral, disposable scratchpads where the agent can fail safely, iterate against a live compiler or test runner, and produce an isolated git patch without touching the host operating system."*

### Q1.2: "How did you define the boundaries of your system? Where does the agent's responsibility end and the platform's begin?"
* **What the interviewer is testing:** Architectural boundaries, separation of concerns, and defensive engineering.
* **Senior-Level Answer:**
  > *"We implemented a strict four-layer architecture:*
  > 1. *The **Brain (LLM Client & Agent Loop)**: Responsible solely for reasoning, task planning, and emitting structured tool calls ([`Harness/_LLM_client.py`](file:///d:/Complex_backend/Cloud_native/Backend/Harness/_LLM_client.py)). It has zero access to Docker sockets, file descriptors, or host network interfaces.*
  > 2. *The **Contract Bridge (Tool Dispatcher)**: Validates schemas, sanitizes inputs, enforces execution timeouts, and intercepts exceptions ([`Harness/_execute_tools.py`](file:///d:/Complex_backend/Cloud_native/Backend/Harness/_execute_tools.py)).*
  > 3. *The **Execution Sandbox (Docker Container)**: A completely isolated Linux environment running under hard cgroups and dropped privileges ([`Sandbox/_sandbox_setup.py`](file:///d:/Complex_backend/Cloud_native/Backend/Sandbox/_sandbox_setup.py)). It only executes what the bridge allows and emits stdout/stderr.*
  > 4. *The **Control Plane & Dual-Tier Persistence**: FastAPI API Gateway ([`brain/_main.py`](file:///d:/Complex_backend/Cloud_native/Backend/brain/_main.py), [`controller/_routes.py`](file:///d:/Complex_backend/Cloud_native/Backend/controller/_routes.py)), Neon Serverless PostgreSQL ([`DB/_projects.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_projects.py)), and Neon S3 Object Storage ([`DB/_object_storage.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_object_storage.py)).*
  > 
  > *By keeping these boundaries airtight, we can swap out the LLM provider (Gemini $\to$ Claude $\to$ DeepSeek) or swap out the isolation technology (Docker $\to$ Firecracker microVMs) without rewriting the rest of the system."*

---

## Category 2: System Architecture & Concurrency at Scale (100+ Agents)

### Q2.1: "How do you prevent the Docker daemon from locking up under a thundering herd when many agents launch simultaneously?"
* **What the interviewer is testing:** Docker daemon architecture, UNIX socket serialization, concurrency control, and rate limiting.
* **Senior-Level Answer:**
  > *"The Docker daemon (`dockerd`) communicates over a single UNIX socket (`/var/run/docker.sock`) or Windows named pipe. If 100 agents try to call `docker run` concurrently within the same second, the socket backlog overflows, thread pools exhaust, and the daemon deadlocks or times out.*
  > 
  > *We solve this with two architectural mechanisms:*
  > 1. * **Asynchronous Semaphore / Queue:** In Python/FastAPI, container provisioning is fronted by an `asyncio.Semaphore(MAX_CONCURRENT_CREATIONS)` (or Celery/Redis in distributed setups). This throttles concurrent daemon creation calls to a safe threshold (e.g., 3 locally, 10 per worker in cloud), queuing subsequent requests.*
  > 2. * **Pre-Warmed Standby Pool:** Instead of cold-starting containers on-demand, an asynchronous pool manager maintains a buffer of idle, pre-spawned containers (`command="sleep infinity"`). When an agent requests a sandbox, checkout latency is under 50ms without hitting `client.containers.run()` at all."*

### Q2.2: "How does the system prevent blocking FastAPI's async event loop when using the synchronous Docker SDK?"
* **What the interviewer is testing:** Python asyncio internals, event loop blocking, thread pool executors, and cross-thread communication.
* **Senior-Level Answer:**
  > *"The official Docker Python SDK (`docker-py`) makes synchronous, blocking HTTP calls over a UNIX socket or Windows named pipe. If you call `container.exec_run()` or `run_agent_loop()` inside an async endpoint like `@api_router.post('/runs')`, the event loop is blocked. All concurrent requests, WebSocket pings, and health check endpoints freeze until the agent finishes.*
  > 
  > *In [`controller/_routes.py`](file:///d:/Complex_backend/Cloud_native/Backend/controller/_routes.py#L253-L262), we decouple execution using `loop.run_in_executor(None, _execute_agent_background, ...)`:*
  > * *The agent loop executes in a separate worker thread from Python's default `ThreadPoolExecutor`.*
  > * *To send real-time thoughts and tool events back to async WebSocket clients, the background thread uses a sync-to-async bridge: `asyncio.run_coroutine_threadsafe(_async_step_callback(event_data), loop)`.*
  > * *This guarantees that the main event loop remains 100% responsive, handling HTTP requests and WebSocket streaming concurrently with zero stalls."*

### Q2.3: "How does the system handle real-time observability when multiple agents are executing commands simultaneously?"
* **What the interviewer is testing:** Backpressure, streaming protocols (WebSockets/SSE), async I/O, and frontend control plane design.
* **Senior-Level Answer:**
  > *"We built an event-driven streaming pipeline:*
  > * *Inside [`_agent_loop.py`](file:///d:/Complex_backend/Cloud_native/Backend/Harness/_agent_loop.py#L72-L78), we hook an `event_callback` into every thought emission and tool execution.*
  > * *Inside [`controller/_routes.py`](file:///d:/Complex_backend/Cloud_native/Backend/controller/_routes.py#L107-L141), a `ConnectionManager` maintains active WebSocket client lists mapped by `run_id`.*
  > * *When a tool runs, [`_async_step_callback`](file:///d:/Complex_backend/Cloud_native/Backend/controller/_routes.py#L157-L171) simultaneously broadcasts JSON events (`thought`, `tool_execution`, `status`, `finish`) to all connected WebSocket subscribers and persists the step in Neon PostgreSQL.*
  > * *The Next.js 15 frontend consumes the stream and renders output live via `xterm.js` and dynamic step cards."*

### Q2.4: "How do you prevent zombie containers from leaking memory and PIDs when tasks crash or time out?"
* **What the interviewer is testing:** Container lifecycle management, background reconciliation, and failure recovery.
* **Senior-Level Answer:**
  > *"Relying purely on `try...finally` blocks is insufficient: if the backend server process crashes, experiences a hard kill (`SIGKILL`), or encounters an unhandled exception, containers and volumes remain orphaned on the host.*
  > 
  > *In [`brain/_main.py`](file:///d:/Complex_backend/Cloud_native/Backend/brain/_main.py#L26-L61), we implemented the **Janitor Reaper** service:*
  > * *An asynchronous background task registered in FastAPI's `lifespan` runs every 300 seconds (5 minutes).*
  > * *It queries Docker for all containers matching the prefix `agent-sandbox-`.*
  > * *It parses each container's creation timestamp (`c.attrs['Created']`). Any container older than 600 seconds (10-minute TTL) is forcibly destroyed via `c.remove(v=True, force=True)`.*
  > * *This ensures that even if an agent hangs or a server reboots, leaked compute and disk inodes are automatically reclaimed."*

---

## Category 3: Core Design Decisions & Engineering Trade-Offs

### Q3.1: "Why did you use Docker containers instead of Firecracker MicroVMs or WebAssembly (Wasm)?"
* **What the interviewer is testing:** Technology selection trade-offs, isolation vs. startup latency, ecosystem compatibility.
* **Senior-Level Answer:**
  > *"This was an intentional engineering trade-off across three vectors:*
  > 
  > | Technology | Cold Startup Latency | Security Isolation | Ecosystem / Tooling Support |
  > | :--- | :--- | :--- | :--- |
  > | **WebAssembly (Wasm)** | $< 10\text{ms}$ | High (Memory sandbox) | **Poor:** Cannot run arbitrary Python packages, C-extensions, git, or bash scripts. |
  > | **Firecracker MicroVMs** | $\sim 150\text{ms}$ | **Highest (Hardware KVM)** | **Complex:** Requires bare-metal Linux instances with nested virtualization; hard to develop locally on Windows/macOS. |
  > | **Docker (Hardened Cgroups)** | $\mathbf{\sim 500\text{ms}}$ | **High (Cgroups + Cap Drop)** | **Best:** Native support for any Linux package, git, compilers, local dev, and cloud deployment. |
  > 
  > *For an AI coding agent that must run standard test suites (`pytest`, `git`, `python`, `node`), Docker provides 100% Linux toolchain compatibility. By stripping root capabilities (`cap_drop=['ALL']`) and disabling new privileges, we achieve near-VM security with local developer ergonomics."*

### Q3.2: "Why did you use the Base64 file transfer pattern instead of Docker's native `put_archive` (tar streaming)?"
* **What the interviewer is testing:** Linux shell limits, I/O performance, simplicity vs. scalability boundaries.
* **Senior-Level Answer:**
  > *"We evaluated both:*
  > * * **Why Base64 initially:** Writing code via shell commands fails if you use raw string interpolation because quotes, backticks, newlines, and variable expansions (`$VAR`) break bash syntax. Base64 converts arbitrary code into safe alphanumeric ASCII (`[A-Za-z0-9+/=]`), making `printf %s ... | base64 -d > path` 100% resilient against shell escaping bugs and code injection.*
  > * * **The Known Trade-Off:** The Linux kernel limits shell command arguments via `ARG_MAX` (typically 2MB on modern kernels). Passing a 10MB file via `printf` will fail with `Argument list too long`.*
  > * * **The Production Evolution:** For files under 1MB, Base64 is fast, stateless, and requires no tar packaging. For large files or binary assets, our plan incorporates Docker’s native `container.put_archive()` tar stream API as a graceful fallback."*

### Q3.3: "If `network_disabled=True` for security, how can the agent install missing dependencies (`pip install`)?"
* **What the interviewer is testing:** Network security policies, egress control, supply-chain defense.
* **Senior-Level Answer:**
  > *"Completely disabling the network (`network_disabled=True`) is the safest default because it guarantees zero data exfiltration and prevents SSRF attacks against internal infrastructure.*
  > 
  > *In production, we handle dependencies using two strategies:*
  > 1. * **Prebuilt Caching (Our Chosen Baseline):** Base images are built with the target repository's virtual environment and standard test suites pre-installed ([`Backend/Dockerfile`](file:///d:/Complex_backend/Cloud_native/Backend/Dockerfile)). The agent never needs to touch the public internet at runtime.*
  > 2. * **Egress Forward Proxy:** If runtime installation is strictly necessary, we re-enable networking but route all container egress through an authenticating proxy (like Squid or Envoy) with a strict domain allowlist (e.g., allow `pypi.org`, `files.pythonhosted.org`, and `github.com` only; deny all internal RFC-1918 subnets and arbitrary external IPs)."*

---

## Category 4: Linux Kernel & Container Security Implementation

### Q4.1: "Explain the exact Linux kernel mechanisms behind your container resource limits."
* **What the interviewer is testing:** Understanding of Linux cgroups (v1/v2), kernel process tables, and OOM killer behavior.
* **Senior-Level Answer:**
  > *"In [`_sandbox_setup.py`](file:///d:/Complex_backend/Cloud_native/Backend/Sandbox/_sandbox_setup.py#L61-L65), we configure three cgroup controllers directly through the Docker SDK:*
  > 1. * **Memory (`mem_limit="512m"`):** Configures the `memory.max` cgroup controller. If the agent's code triggers a memory leak or allocates a 2GB array, the kernel OOM killer sends a `SIGKILL` to the offending process inside the container. The host operating system's RAM is never compromised.*
  > 2. * **CPU (`nano_cpus=1_000_000_000`):** Configures the `cpu.max` CFS (Completely Fair Scheduler) quota. It allocates exactly $1.0$ CPU second per second of wall-clock time. Even if an agent runs an infinite `while True:` loop, it consumes at most 1 CPU core, leaving the host's remaining cores free.*
  > 3. * **Process Ceiling (`pids_limit=64`):** Sets `pids.max`. Mitigates classic fork bombs (`:(){ :|:& };:`). Once 64 processes are spawned, subsequent `fork()` syscalls fail with `EAGAIN` (Resource temporarily unavailable), neutralizing the attack immediately."*

### Q4.2: "What is the difference between disk space exhaustion and inode exhaustion, and how does your code prevent both?"
* **What the interviewer is testing:** Storage driver internals (`overlay2`), filesystem architecture, and real-world failure mode experience.
* **Senior-Level Answer:**
  > *"This is a classic failure mode in AI coding platforms:*
  > * * **Disk Space (Megabytes/Gigabytes):** Measures the total volume of raw bytes stored on disk.*
  > * * **Inodes (Index Nodes):** Data structures on Unix filesystems storing file metadata (permissions, ownership, disk block pointers). An ext4 filesystem has a **fixed, immutable number of inodes** created at format time.*
  > * * **The Paradox:** Repositories have tens of thousands of tiny files (`.git/`, `__pycache__`, `node_modules/`, venvs). Even a 10-byte file consumes 1 full Inode. If you leave 1,000 dead sandbox volumes on disk, you can consume 100% of your host's Inodes while still having 300 GB of free disk space, causing `No space left on device` crashes.*
  > * * **Our Solution:** In `destroy_sandbox`, we call `container.remove(v=True, force=True)`. The `v=True` flag forces Docker to delete associated anonymous volumes. Furthermore, we explicitly unlink named volumes via `client.volumes.get(volume_name).remove(force=True)` in a `finally:` block, guaranteeing zero orphaned volume or inode leaks."*

### Q4.3: "Why use `cap_drop=['ALL']` and `security_opt=['no-new-privileges']` if the container is already running as root?"
* **What the interviewer is testing:** Linux Capabilities model, container breakout vectors, privilege escalation.
* **Senior-Level Answer:**
  > *"Inside a standard container, 'root' (UID 0) by default retains dangerous kernel capabilities like `CAP_NET_RAW` (packet crafting), `CAP_SYS_CHROOT`, and `CAP_MKNOD`.*
  > * *`cap_drop=['ALL']` strips every single capability from the bounding set. Even though the process runs as UID 0, it cannot open raw network sockets, modify kernel modules, mount filesystems, or manipulate devices.*
  > * *`security_opt=['no-new-privileges']` sets the kernel flag `PR_SET_NO_NEW_PRIVS`. This ensures that child processes cannot acquire additional execution privileges through `setuid` or `setgid` binaries (like `sudo` or `pkexec`), blocking the primary vector for container breakouts."*

---

## Category 5: Cognitive Agent Loop & Tooling Failure Modes

### Q5.1: "How does your ReAct loop maintain state across multi-turn tool invocations without losing context or blowing up token limits?"
* **What the interviewer is testing:** Context window management, message schemas, and function-response protocol.
* **Senior-Level Answer:**
  > *"In [`_agent_loop.py`](file:///d:/Complex_backend/Cloud_native/Backend/Harness/_agent_loop.py#L58-L135), we implement a stateful multi-turn session using the official Google GenAI SDK:*
  > 1. *The initial user prompt kicks off the session.*
  > 2. *When Gemini emits a `FunctionCall` (e.g. `read_file(path="src/main.py")`), we execute the tool in Docker and wrap the output inside a `types.Part.from_function_response(name=..., response={"result": ...})`.*
  > 3. *We pass this structured response back into `chat.send_message()`, which appends it to the turn history.*
  > 4. *To prevent context bloat: We set a hard ceiling (`max_iterations=15`). In addition, verbose tool outputs (like full file listings or massive test logs) are truncated or summarized before being reflected into the chat history, preserving token budget for reasoning."*

### Q5.2: "What happens when an LLM hallucinates an invalid tool call or invalid arguments?"
* **What the interviewer is testing:** Error handling, resilience, self-healing agent loops.
* **Senior-Level Answer:**
  > *"We treat tool errors as informative feedback for the LLM rather than crashing exceptions:*
  > * *In [`_execute_tools.py`](file:///d:/Complex_backend/Cloud_native/Backend/Harness/_execute_tools.py#L38-L58), we implemented upfront defensive validation guards (Issue #006). If the model calls `create_file` without a `path`, we catch it before touching Docker and return `{"status": "error", "error": "Missing required parameter: 'path'"}`.*
  > * *If a shell command fails (e.g. `pytest` fails with assertion errors), we capture `stderr` and return `{"status": "error", "exit_code": 1, "stderr": "..."}`.*
  > * *Because the error is packaged as a structured `function_response`, the LLM sees its mistake in the next turn and self-corrects (e.g., 'Oh, tests failed because of ZeroDivisionError on line 5, let me patch line 5')."*

---

## Category 6: Cloud Persistence, Database & Object Storage (Neon)

### Q6.1: "Why did you implement a dual-tier persistence model instead of storing everything in PostgreSQL?"
* **What the interviewer is testing:** Storage tiering, database optimization, blob storage trade-offs, and scalability.
* **Senior-Level Answer:**
  > *"Storing large text blobs—such as 500KB git diffs, build logs, and workspace snapshots—directly inside relational database tables (like PostgreSQL `TEXT` or `JSONB` columns) is an anti-pattern at scale:*
  > * *It balloons database table sizes, causing PostgreSQL buffer pool cache thrashing.*
  > * *It degrades query performance for metadata scans, list views, and status updates.*
  > * *PostgreSQL TOAST tables add extra disk reads for every row lookup.*
  > 
  > *We implemented a strict dual-tier architecture:*
  > 1. * **Neon Serverless PostgreSQL ([`_projects.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_projects.py), [`_chat.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_chat.py)):** Stores lean, indexable relational records—project metadata, agent run statuses, execution step timestamps, and conversational chat threads.*
  > 2. * **Neon S3-Compatible Object Storage ([`_object_storage.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_object_storage.py)):** High-durability bucket (`agent-artifacts`) storing unified patch diffs (`runs/{id}/patch.diff`) and raw terminal execution logs (`runs/{id}/terminal.log`).*
  > 
  > *This guarantees sub-millisecond database queries while offloading heavy assets to durable, inexpensive object storage."*

### Q6.2: "How do you handle dropped connections in Neon Serverless PostgreSQL when the compute scales to zero?"
* **What the interviewer is testing:** Serverless database architecture, TCP connection lifecycle, connection pooling.
* **Senior-Level Answer:**
  > *"Neon PostgreSQL is serverless and auto-suspends inactive compute nodes to reduce cost. When a compute suspends, open TCP sockets to clients are terminated. Standard connection pools like SQLAlchemy without keep-alives assume connections remain valid, causing the next query to crash with `ConnectionResetError` or `OperationalError: SSL connection has been closed unexpectedly`.*
  > 
  > *In [`DB/_projects.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_projects.py#L37-L41), we configure SQLAlchemy's `create_async_engine` with `pool_pre_ping=True`:*
  > ```python
  > engine = create_async_engine(
  >     DATABASE_URL,
  >     echo=False,
  >     pool_pre_ping=True,  # Transparently verifies and reconnects dropped sockets
  > )
  > ```
  > *Before handing a connection from the pool to a request handler, SQLAlchemy issues an optimistic test ping (`SELECT 1`). If the connection was terminated by serverless suspension, it recycles the connection seamlessly without throwing 500 Internal Server Errors to clients."*

### Q6.3: "Why did you specify `addressing_style: 'path'` in Boto3 for Neon Object Storage?"
* **What the interviewer is testing:** S3 API standards, virtual-hosted vs. path-style addressing, cloud storage interop.
* **Senior-Level Answer:**
  > *"By default, modern AWS S3 uses virtual-hosted style URLs: `https://<bucket>.<endpoint>`. However, S3-compatible cloud object storage providers (like Neon, MinIO, or Ceph) often route through a base hostname where bucket subdomains do not have wildcard DNS records configured.*
  > 
  > *In [`DB/_object_storage.py`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_object_storage.py#L44-L51), we explicitly enforce path-style addressing:*
  > ```python
  > self.s3_client = boto3.client(
  >     "s3",
  >     endpoint_url=AWS_ENDPOINT_URL_S3,
  >     config=Config(s3={"addressing_style": "path"})
  > )
  > ```
  > *This directs requests to `https://<endpoint>/<bucket>/<key>`, ensuring 100% compatibility with Neon's S3 proxy endpoints without DNS resolution failures."*

### Q6.4: "How does the conversational chat API preserve multi-turn history when calling Gemini?"
* **What the interviewer is testing:** State management in stateless HTTP APIs, conversational context windows, LLM message translation.
* **Senior-Level Answer:**
  > *"In [`controller/_routes.py`](file:///d:/Complex_backend/Cloud_native/Backend/controller/_routes.py#L504-L572) on `POST /api/chats/{chat_id}/messages`:*
  > 1. *We persist the incoming user prompt to Neon PostgreSQL under table `chat_messages`.*
  > 2. *We query all historical messages for the session in chronological order via [`get_chat_history()`](file:///d:/Complex_backend/Cloud_native/Backend/DB/_chat.py#L108-L119).*
  > 3. *We translate each database record into Google GenAI's `types.Content` object, mapping `user` to role `'user'` and `assistant` to role `'model'`.*
  > 4. *We pass this multi-turn history along with the session's `system_prompt` into `client.models.generate_content()`.*
  > 5. *We save the resulting assistant reply in Neon PostgreSQL and touch `chat_sessions.updated_at` so the UI sidebar sorts active conversations to the top.*
  > 
  > *This makes our HTTP chat endpoint completely stateless while maintaining full conversational memory in Neon."*

---

## Category 7: Problem-Solving Strategies & Incident Debugging (Issues #001–#008)

### Q7.1: "Describe your methodology when a defect occurs in this distributed harness."
* **What the interviewer is testing:** Disciplined engineering methodology vs. random trial-and-error patching.
* **Senior-Level Answer:**
  > *"We strictly adhere to the 6-pillar protocol codified in our [`Issues.md`](file:///d:/Complex_backend/Cloud_native/Backend/Issues.md):*
  > 1. * **Observe Failure:** Inspect exact exit codes, stdout/stderr, and stack traces.*
  > 2. * **Ground Mental Model:** Trace physical files, environment configs, and dependency trees.*
  > 3. * **Formulate Falsifiable Hypothesis:** State the exact causal mechanism (e.g., 'Hypothesis: Eager docker.from_env() call crashes API server at boot if Docker Desktop daemon is offline').*
  > 4. * **Surgical Remediation:** Apply the fix with the smallest possible blast radius without syntax masking or dummy fallbacks.*
  > 5. * **Invariance Verification:** Re-run compilations, unit assertions, and deterministic execution scripts to confirm the defect is resolved and no regressions exist.*
  > 6. * **Document:** Log an Issue Resolution Report detailing Root Cause, Changes, and Evidence in `Issues.md`."*

### Q7.2: "What was Issue #008, and why was eager initialization an architectural defect?"
* **What the interviewer is testing:** Import-time side effects, lazy initialization pattern, service resilience.
* **Senior-Level Answer:**
  > *"During development of the FastAPI gateway, our application crashed immediately on startup with `docker.errors.DockerException: Error while fetching server API version: (2, 'CreateFile', 'The system cannot find the file specified.')`.*
  > * * **Root Cause:** In [`Sandbox/_sandbox_setup.py`](file:///d:/Complex_backend/Cloud_native/Backend/Sandbox/_sandbox_setup.py), `client = docker.from_env()` was executed at top-level module scope during file import. Because `controller` and `brain._main` imported `Sandbox`, FastAPI tried to connect to Docker before the app could even initialize routes, database tables, or health checks.*
  > * * **Surgical Remediation:** We replaced top-level instantiation with a lazy cached getter `get_docker_client()`. The Docker client is only connected when `create_sandbox` or `destroy_sandbox` is explicitly invoked at runtime.*
  > * * **Outcome:** The API Gateway can boot, serve documentation at `/docs`, execute database migrations, and handle chat queries completely independently of Docker daemon availability."*

### Q7.3: "Why did you encounter exit code 127 (`git: not found`) and how did you architect a solution?"
* **What the interviewer is testing:** Debugging under production constraints, Linux exit codes, image customization.
* **Senior-Level Answer:**
  > *"During end-to-end testing, the agent successfully fixed code and passed unit tests, but `get_git_diff` failed with exit code 127 (`sh: 1: git: not found`).*
  > * * **Root Cause:** In pursuit of sub-second startup latency, we initially used `python:3.12-slim`. To keep the image under 45MB, Debian maintainers omit `git` and development tools.*
  > * * **Architectural Solution:** Rather than installing `git` on the fly via `apt-get` during every run (which would add 30–60 seconds of network latency and require outbound internet access), we created a custom prebuilt base image ([`Backend/Dockerfile`](file:///d:/Complex_backend/Cloud_native/Backend/Dockerfile)) that layers `git` and global git configuration on top of `python:3.12-slim`.*
  > * *Docker caches this locally as `cloud-native-sandbox:latest`, keeping sandbox startup under 0.8 seconds while providing full git diff capability."*

---

## Summary Cheat-Sheet: Top 6 Metrics & Parameters to Remember

| Metric / Parameter | Value | Technical Reason |
| :--- | :---: | :--- |
| **Sandbox Memory Ceiling** | `512 MB` | Cgroups `memory.max` prevents host RAM starvation while running concurrent agents. |
| **Sandbox CPU Allocation** | `1.0 Core` | Cgroups `cpu.max` CFS quota prevents 100% CPU lockups from infinite loops. |
| **PID Ceiling** | `64 Processes` | Cgroups `pids.max` mitigates fork bombs immediately. |
| **Environment Startup Time** | `< 0.8 Seconds` | Achieved via prebuilt local image caching (`cloud-native-sandbox:latest`). |
| **Janitor Reaper Scan Interval** | `300s (5 min)` | Periodically purges orphaned sandboxes older than 10 minutes (`600s TTL`). |
| **Local Concurrency Cap** | `3 Sandboxes` | Concurrency semaphore tuned specifically to protect a 16 GB RAM developer laptop. |
