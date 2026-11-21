# Cloud-Native AI Coding Harness: Senior Technical Interview Guide Quick-Index (`Asked1.md`)

*(For the complete, in-depth guide with architectural diagrams, code snippets, and verbatim answers, see [Backend/Asked.md](file:///d:/Complex_backend/Cloud_native/Backend/Asked.md))*

---

## Quick Navigation: Top Interview Questions & Categories

### 1. Approach & High-Level Philosophy
* **Q1.1:** Why build a custom coding harness instead of calling an LLM API directly from a web backend?
* **Q1.2:** How did you define system boundaries between the LLM Brain, the Dispatcher, the Sandbox, and the Persistence/Control Plane?

### 2. System Architecture & Concurrency at Scale (100+ Agents)
* **Q2.1:** How do you prevent the Docker daemon from locking up under a thundering herd when many agents launch simultaneously?
* **Q2.2:** How does the system prevent blocking FastAPI's async event loop when using the synchronous Docker SDK (`loop.run_in_executor`)?
* **Q2.3:** How does the system stream real-time execution traces, thoughts, and terminal outputs without thread lockups (`ConnectionManager`)?
* **Q2.4:** How do you prevent zombie containers from leaking memory and PIDs when tasks crash or time out (`janitor_reaper`)?

### 3. Core Design Decisions & Engineering Trade-Offs
* **Q3.1:** Why choose Docker over Firecracker MicroVMs or WebAssembly (Wasm)?
* **Q3.2:** Why the Base64 file transfer pattern instead of Docker's native `put_archive` tar stream?
* **Q3.3:** How does the agent install packages when networking is disabled (`network_disabled=True`)?

### 4. Linux Kernel & Container Security Implementation
* **Q4.1:** What are the exact Linux cgroup mechanisms behind your memory, CPU, and PID limits?
* **Q4.2:** What is the difference between disk space exhaustion and inode exhaustion, and how is it prevented?
* **Q4.3:** Why drop all capabilities (`cap_drop=['ALL']`) and disable new privileges (`no-new-privileges`)?

### 5. Cognitive Agent Loop & Tooling Failure Modes
* **Q5.1:** How does your ReAct loop maintain state across multi-turn tool invocations without blowing token limits?
* **Q5.2:** What happens when an LLM hallucinates an invalid tool call or invalid arguments?

### 6. Cloud Persistence, Database & Object Storage (Neon)
* **Q6.1:** Why did you implement a dual-tier persistence model (Neon PostgreSQL + S3 Object Storage) instead of storing everything in SQL?
* **Q6.2:** How do you handle dropped connections in Neon Serverless PostgreSQL when the compute scales to zero (`pool_pre_ping=True`)?
* **Q6.3:** Why did you specify `addressing_style: 'path'` in Boto3 for Neon Object Storage?
* **Q6.4:** How does the conversational chat API preserve multi-turn history when calling Gemini?

### 7. Problem-Solving Strategies & Incident Debugging (Issues #001–#008)
* **Q7.1:** What is your disciplined 6-pillar engineering methodology when an incident occurs?
* **Q7.2:** What was Issue #008, and why was eager Docker client initialization an architectural defect (`get_docker_client`)?
* **Q7.3:** Why did you encounter exit code 127 (`git: not found`) and how did you architect a solution (`Dockerfile`)?

---

### Core System Configuration Baseline

| Parameter | Value | Architectural Purpose |
| :--- | :---: | :--- |
| **Sandbox Memory Ceiling** | `512 MB` | Linux cgroups `memory.max` prevents host RAM starvation. |
| **Sandbox CPU Allocation** | `1.0 Core` | Linux cgroups `cpu.max` CFS quota prevents 100% CPU lockups. |
| **PID Ceiling** | `64 Processes` | Linux cgroups `pids.max` mitigates fork bombs. |
| **Sandbox Startup Latency** | `< 0.8 Seconds` | Achieved via prebuilt local image caching (`cloud-native-sandbox:latest`). |
| **Janitor Reaper TTL** | `600s (10 min)`| Autonomous background cleaner scans every 300s, purging zombie containers. |
| **DB Connection Pool** | `pool_pre_ping=True` | Recycles dead TCP sockets after Neon serverless compute suspension. |

---

*Read the full in-depth answers and code samples in **[Backend/Asked.md](file:///d:/Complex_backend/Cloud_native/Backend/Asked.md)**.*
