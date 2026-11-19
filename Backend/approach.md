# Cloud-Native AI Coding Harness: Architectural Approach & Engineering Roadmap

---

## 1. The Core Engineering Philosophy

When building autonomous AI systems that interact with operating systems, the guiding philosophy must be:

> **"Assume the model will hallucinate, execute dangerous code, and loop infinitely. Design the sandbox so that even the worst-case hallucination cannot compromise the host."**

### Three Foundational Principles:
1. **Separation of Concerns:**  
   The Brain (LLM Orchestrator) has zero knowledge of Docker internal sockets.  
   The Sandbox (Container) has zero knowledge of LLM prompts.  
   The Dispatcher (`_execute_tools.py`) acts as the strict contract boundary between them.
2. **Defense-in-Depth:**  
   Never rely on prompt engineering alone to stop harmful actions. If the LLM tries to run `rm -rf /` or a fork bomb, kernel-level cgroups (`mem_limit="512m"`, `pids_limit=64`, `cap_drop=["ALL"]`) must neutralize it automatically.
3. **Storage & Ephemerality:**  
   A sandbox is disposable compute. When an agent run finishes, the container and volume are annihilated, leaving zero orphaned files or storage leaks.

---

## 2. The 5-Phase Engineering Roadmap

```text
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 1: HOST & ENVIRONMENT GUARDRAILS                           │
│ - Hardware limits (.wslconfig memory=6GB)                        │
│ - Virtual environment setup via uv                               │
│ - Docker socket connectivity verification                        │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────┐
│ PHASE 2: DISPOSABLE COMPUTE & SANDBOX ENGINE                     │
│ - Dynamic UUID naming & isolation (_sandbox_setup.py)            │
│ - Base64 safe file transfer & stream demuxing                    │
│ - Prebuilt Docker image with git tooling                         │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────┐
│ PHASE 3: COGNITIVE TOOLING & THE REACT LOOP                      │
│ - Tool contract schemas (_tools.py)                              │
│ - Guarded tool dispatcher (_execute_tools.py)                    │
│ - Multi-capability Gemini client (_LLM_client.py)                │
│ - Autonomous ReAct execution loop (_agent_loop.py)               │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────┐
│ PHASE 4: STATE PERSISTENCE & OBJECT STORAGE (Upcoming)           │
│ - Neon Serverless PostgreSQL for project & run metadata          │
│ - Object storage (S3 / R2) for git diff patches & full logs      │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────┐
│ PHASE 5: REAL-TIME CONTROL PLANE & UI (Upcoming)                 │
│ - FastAPI WebSockets / SSE streaming endpoint                    │
│ - Next.js 15 dashboard (xterm.js terminal + Monaco diff viewer)  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Local Machine vs. Cloud Scale Strategy

A major design challenge is: **How do we design for 100+ concurrent agents while developing safely on a 16 GB RAM local laptop?**

### The Dual-Mode Strategy:

| Challenge | Local Machine Strategy (16 GB RAM) | Cloud Production Strategy (AWS / K8s) |
| :--- | :--- | :--- |
| **Concurrency** | In-memory `asyncio.Semaphore(3)` caps simultaneous sandboxes at 3. | Distributed worker queue (Celery / Redis / Temporal) scales across multiple nodes. |
| **Memory Allocation** | $3 \text{ containers} \times 512\text{ MB} = \mathbf{1.5\text{ GB RAM}}$, safely leaving 14.5 GB for Windows. | 64 GB cloud instances sustain $\mathbf{100\text{ containers}} \times 512\text{ MB} = 50\text{ GB RAM}$. |
| **Storage & Inodes** | Code lives on Drive `D:` (163 GB free). Containers wiped with `v=True`. | Ephemeral NVMe scratch disks or in-memory `tmpfs` mounts auto-pruned per task. |
| **Startup Speed** | Prebuilt local Docker image (`cloud-native-sandbox:latest`) starts in $< 0.8$s. | Pre-warmed standby container pool keeps 5 idle containers waiting for instant checkout. |

---

## 4. The Scientific Debugging Approach (`Issues.md` Protocol)

Whenever bugs or unexpected errors occur during development, we follow the strict 6-pillar protocol defined in **`Backend/Issues.md`**:

```text
1. Observe Error (Stack trace & Exit codes)
             ↓
2. Ground Mental Model (Trace physical files & dependencies)
             ↓
3. Formulate Falsifiable Hypothesis ("Defect occurs because condition X causes state Y")
             ↓
4. Apply Surgical Remediation (Smallest blast radius, zero syntax masking)
             ↓
5. Verify Invariance (Compilation, unit assertions, non-destructive test scripts)
             ↓
6. Log Resolution Report in Issues.md (Root Cause, Fix, Verification Evidence)
```

### Examples of Issues Resolved Using This Approach:
* **Issue #001 (P1):** Docker tag typo (`python-3.12-slim` vs `python:3.12-slim`) caused 404 client error. Resolved by enforcing standard `repo:tag` syntax.
* **Issue #003 (P1):** Sibling package import failure resolved by transitioning from direct script calls to standard root module execution (`python -m Harness._execute_tools`).
* **Issue #005 (P2):** Unchecked tuple unpacking in `exec_run` protected with safe null-coalescing fallback.
* **Issue #007 (P3):** Missing `git` in `-slim` image resolved by architecting a custom prebuilt base Dockerfile.

---

## 5. How to Present This Project on a Resume & in Interviews

When speaking to senior backend, infrastructure, or AI platform interviewers, frame the conversation around **Systems Architecture**, not prompt engineering:

### 1. The Resume Summary Pitch
> *"I built a cloud-native coding agent harness that safely executes autonomous agent loops inside isolated Docker sandboxes. I solved key container security risks by enforcing cgroups and dropping Linux root capabilities, eliminated storage and inode leaks with automated volume teardowns, and optimized startup latency to under 1 second using prebuilt image caching."*

### 2. Answering Critical Technical Interview Questions:

#### Q: "How did you prevent 100 concurrent agents from locking the Docker daemon?"
> *"I prevented daemon contention by using an asynchronous worker semaphore rather than hammering the Docker socket with concurrent creation calls. For production, I designed a pre-warmed pool of idle standby containers so tasks grab an active sandbox instantly without triggering cold `docker run` calls."*

#### Q: "How did you handle storage and inode exhaustion?"
> *"Docker leaves unattached volumes behind by default. In `destroy_sandbox`, I passed `v=True` on container removal and explicitly deleted named volumes. I also implemented a background janitor task that scans and prunes unattached volumes whose TTL has expired."*

#### Q: "Why did you use Base64 for file creation instead of standard echo?"
> *"Writing code directly over a bash shell breaks easily on quotes, backticks, dollar signs, and multi-line formatting. Base64 transforms code into an ASCII stream, guaranteeing bit-for-bit file integrity without shell injection risks."*

#### Q: "If network is disabled (`network_disabled=True`), how does the agent install packages?"
> *"In the base design, sandboxes are air-gapped to prevent data exfiltration. For repos requiring dependencies, we use custom prebuilt Docker images with pre-installed virtual environments, or an outbound forward proxy with strict domain allowlists (e.g., PyPI and GitHub only)."*
