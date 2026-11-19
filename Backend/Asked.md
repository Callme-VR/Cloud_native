# Cloud-Native AI Coding Harness: Senior Technical Interview Guide (`Asked.md`)

> A comprehensive, battle-tested interview guide covering the **Approach, Architecture, Design Decisions, Systems Implementation, and Problem-Solving Strategies** for this Cloud-Native AI Coding Agent Harness.

---

## Table of Contents
1. [Category 1: Approach & High-Level Philosophy](#category-1-approach--high-level-philosophy)
2. [Category 2: System Architecture & Concurrency at Scale (100+ Agents)](#category-2-system-architecture--concurrency-at-scale-100-agents)
3. [Category 3: Core Design Decisions & Engineering Trade-Offs](#category-3-core-design-decisions--engineering-trade-offs)
4. [Category 4: Linux Kernel & Container Security Implementation](#category-4-linux-kernel--container-security-implementation)
5. [Category 5: Cognitive Agent Loop & Tooling Failure Modes](#category-5-cognitive-agent-loop--tooling-failure-modes)
6. [Category 6: Problem-Solving Strategies & Incident Debugging](#category-6-problem-solving-strategies--incident-debugging)

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
  > *"We implemented a strict tripartite boundary:*
  > 1. *The **Brain (LLM Client & Agent Loop)**: Responsible solely for reasoning, task planning, and emitting structured tool calls. It has zero access to Docker sockets, file descriptors, or host network interfaces.*
  > 2. *The **Contract Bridge (Tool Dispatcher)**: Validates schemas, sanitizes inputs, enforces execution timeouts, and intercepts exceptions.*
  > 3. *The **Execution Sandbox (Docker Container)**: A completely isolated Linux environment running under hard cgroups and dropped privileges. It only executes what the bridge allows and emits stdout/stderr.*
  > 
  > *By keeping these boundaries airtight, we can swap out the LLM provider (Gemini $\rightarrow$ Claude $\rightarrow$ local DeepSeek) or swap out the isolation technology (Docker $\rightarrow$ Firecracker microVMs) without rewriting the rest of the system."*

---

## Category 2: System Architecture & Concurrency at Scale (100+ Agents)

### Q2.1: "You claim support for 100+ concurrent agents. How do you prevent the Docker daemon from locking up under a thundering herd?"
* **What the interviewer is testing:** Docker daemon architecture, UNIX socket serialization, concurrency control, and rate limiting.
* **Senior-Level Answer:**
  > *"The Docker daemon (`dockerd`) communicates over a single UNIX socket (`/var/run/docker.sock`). If 100 agents try to call `docker run` concurrently within the same second, the socket backlog overflows, thread pools exhaust, and the daemon deadlocks or times out.*
  > 
  > *We solve this with two architectural mechanisms:*
  > 1. * **Asynchronous Semaphore / Queue:** In Python/FastAPI, container provisioning is fronted by an `asyncio.Semaphore(MAX_CONCURRENT_CREATIONS)` (or Celery/Redis in distributed setups). This throttles concurrent daemon creation calls to a safe threshold (e.g., 10 per second), queuing subsequent requests.*
  > 2. * **Pre-Warmed Standby Pool:** Instead of cold-starting containers on-demand, an asynchronous pool manager maintains a buffer of idle, pre-spawned containers (`command="sleep infinity"`). When an agent requests a sandbox, checkout latency is under 50ms without hitting `client.containers.run()` at all."*

### Q2.2: "How does the system handle real-time observability when 100 agents are executing terminal commands simultaneously?"
* **What the interviewer is testing:** Backpressure, streaming protocols (WebSockets/SSE), async I/O, and frontend control plane design.
* **Senior-Level Answer:**
  > *"We built an asynchronous streaming pipeline:*
  > * *Inside `_sandbox_executor.py`, `run_command_stream` hooks into Docker's `exec_start(stream=True)` as an asynchronous generator yielding output chunks.*
  > * *The FastAPI controller exposes a WebSocket / Server-Sent Events (SSE) endpoint per run ID.*
  > * *To prevent network buffer bloat when an agent runs a verbose command (like `npm install` or massive test outputs), we implement chunk batching and backpressure: terminal chunks are throttled at 50ms intervals before pushing to the React frontend.*
  > * *The React frontend renders through `xterm.js` using virtualized canvas rendering to prevent DOM thread lockups under heavy output."*

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
  > 1. * **Prebuilt Caching (Our Chosen Baseline):** Base images are built with the target repository's virtual environment and standard test suites pre-installed (`cloud-native-sandbox:latest`). The agent never needs to touch the public internet at runtime.*
  > 2. * **Egress Forward Proxy:** If runtime installation is strictly necessary, we re-enable networking but route all container egress through an authenticating proxy (like Squid or Envoy) with a strict domain allowlist (e.g., allow `pypi.org`, `files.pythonhosted.org`, and `github.com` only; deny all internal RFC-1918 subnets and arbitrary external IPs)."*

---

## Category 4: Linux Kernel & Container Security Implementation

### Q4.1: "Explain the exact Linux kernel mechanisms behind your container resource limits."
* **What the interviewer is testing:** Understanding of Linux cgroups (v1/v2), kernel process tables, and OOM killer behavior.
* **Senior-Level Answer:**
  > *"We configure three cgroup controllers directly through the Docker SDK:*
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
  > *"In `_agent_loop.py`, we implement a stateful multi-turn session using the official Google GenAI SDK:*
  > 1. *The initial user prompt kicks off the session.*
  > 2. *When Gemini emits a `FunctionCall` (e.g. `read_file(path="src/main.py")`), we execute the tool in Docker and wrap the output inside a `types.Part.from_function_response(name=..., response={"result": ...})`.*
  > 3. *We pass this structured response back into `chat.send_message()`, which appends it to the turn history.*
  > 4. *To prevent context bloat: We set a hard ceiling (`max_iterations=15`). In addition, verbose tool outputs (like full file listings or massive test logs) are truncated or summarized before being reflected into the chat history, preserving token budget for reasoning."*

### Q5.2: "What happens when an LLM hallucinates an invalid tool call or invalid arguments?"
* **What the interviewer is testing:** Error handling, resilience, self-healing agent loops.
* **Senior-Level Answer:**
  > *"We treat tool errors as informative feedback for the LLM rather than crashing exceptions:*
  > * *In `_execute_tools.py`, we implemented upfront defensive validation guards. If the model calls `create_file` without a `path`, we catch it before touching Docker and return `{"status": "error", "error": "Missing required parameter: 'path'"}`.*
  > * *If a shell command fails (e.g. `pytest` fails with assertion errors), we capture `stderr` and return `{"status": "error", "exit_code": 1, "stderr": "..."}`.*
  > * *Because the error is packaged as a structured `function_response`, the LLM sees its mistake in the next turn and self-corrects (e.g., 'Oh, tests failed because of ZeroDivisionError on line 5, let me patch line 5')."*

### Q5.3: "Why did you encounter exit code 127 (`git: not found`) and how did you architect a solution?"
* **What the interviewer is testing:** Debugging under production constraints, Linux exit codes, image customization.
* **Senior-Level Answer:**
  > *"During our initial end-to-end testing, the agent successfully fixed the code and verified the tests, but `get_git_diff` failed with exit code 127 (`sh: 1: git: not found`).*
  > * * **Root Cause:** In pursuit of sub-second startup latency, we used `python:3.12-slim`. To keep image size under 45MB, the Debian maintainers omit `git` and development tools.*
  > * * **Architectural Solution:** Rather than installing `git` on the fly via `apt-get` during every run (which would add 30–60 seconds of network latency), we created a custom prebuilt base image (`Backend/Dockerfile`) that layers `git` and global git configuration on top of `python:3.12-slim`. Once built, Docker caches it locally, keeping sandbox startup under 0.8 seconds while providing full git diff capability."*

---

## Category 6: Problem-Solving Strategies & Incident Debugging

### Q6.1: "Describe your methodology when a defect occurs in this distributed harness."
* **What the interviewer is testing:** Disciplined engineering methodology vs. random trial-and-error patching.
* **Senior-Level Answer:**
  > *"We strictly adhere to the 6-pillar protocol codified in our `Issues.md`:*
  > 1. * **Observe Failure:** Inspect exact exit codes, stdout/stderr, and stack traces.*
  > 2. * **Ground Mental Model:** Trace physical files, environment configs, and dependency trees.*
  > 3. * **Formulate Falsifiable Hypothesis:** State the exact causal mechanism (e.g., 'Hypothesis: python-3.12-slim lacks git binary, causing shell exit code 127').*
  > 4. * **Surgical Remediation:** Apply the fix with the smallest possible blast radius without syntax masking or dummy fallbacks.*
  > 5. * **Invariance Verification:** Re-run compilations, unit assertions, and deterministic execution scripts to confirm the defect is resolved and no regressions exist.*
  > 6. * **Document:** Log an Issue Resolution Report detailing Root Cause, Changes, and Evidence in `Issues.md`."*

### Q6.2: "How would you migrate this architecture from a single-host prototype to a distributed multi-tenant cloud service?"
* **What the interviewer is testing:** Distributed systems design, horizontal scaling, cloud architecture.
* **Senior-Level Answer:**
  > *"We would scale across 4 layers:*
  > 1. * **Control Plane (Stateless):** Deploy FastAPI instances behind an Application Load Balancer (ALB). Session state, agent run records, and execution steps are stored in Neon Serverless PostgreSQL with connection pooling.*
  > 2. * **Task Orchestration:** Use a distributed workflow orchestrator (like Temporal or Celery backed by Redis) to schedule agent tasks across worker nodes.*
  > 3. * **Compute Workers:** Instead of running Docker directly on the API server, tasks are dispatched to dedicated worker nodes running an isolated container orchestrator (e.g., Kubernetes with gVisor / Kata Containers, or Nomad).*
  > 4. * **Storage Tier:** Replace local volume storage with ephemeral scratch volumes backed by AWS S3 / Cloudflare R2 for long-term patch archives, git diffs, and execution logs."*

---

## Summary Cheat-Sheet: Top 5 Numbers to Remember in an Interview

| Metric | Value | Technical Reason |
| :--- | :---: | :--- |
| **Sandbox Memory Ceiling** | `512 MB` | Cgroups `memory.max` prevents host RAM starvation while running 100 agents. |
| **Sandbox CPU Allocation** | `1.0 Core` | Cgroups `cpu.max` CFS quota prevents 100% CPU lockups from infinite loops. |
| **PID Ceiling** | `64 Processes` | Cgroups `pids.max` mitigates fork bombs immediately. |
| **Environment Startup Time** | `< 0.8 Seconds` | Achieved via prebuilt local image caching (`cloud-native-sandbox:latest`). |
| **Local Concurrency Cap** | `3 Sandboxes` | Concurrency semaphore tuned specifically to protect a 16 GB RAM developer laptop. |
