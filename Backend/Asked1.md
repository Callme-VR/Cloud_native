# Cloud-Native AI Coding Harness: Senior Technical Interview Guide (`Asked.md`)

*(For the complete, in-depth guide with code snippets and word-for-word answers, see [Backend/Asked.md](file:///d:/Complex_backend/Cloud_native/Backend/Asked.md))*

---

## Quick Navigation: Top Interview Questions & Categories

### 1. Approach & High-Level Philosophy
* **Q1.1:** Why build a custom coding harness instead of calling an LLM API directly?
* **Q1.2:** How did you define system boundaries between the LLM Brain, the Dispatcher, and the Sandbox?

### 2. System Architecture & Concurrency at Scale (100+ Agents)
* **Q2.1:** How do you prevent the Docker daemon from locking up under a thundering herd of 100+ agents?
* **Q2.2:** How does the system stream real-time execution traces and terminal outputs without thread lockups?

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
* **Q5.3:** Why did you encounter exit code 127 (`git: not found`) and how did you architect a solution?

### 6. Problem-Solving Strategies & Incident Debugging
* **Q6.1:** What is your disciplined 6-pillar engineering methodology when an incident occurs?
* **Q6.2:** How would you migrate this architecture from a single-host prototype to a distributed multi-tenant cloud service?

---

*Read the full answers in **[Backend/Asked.md](file:///d:/Complex_backend/Cloud_native/Backend/Asked.md)**.*
