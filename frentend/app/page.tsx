"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Sparkles,
  Terminal,
  FileCode,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  RotateCw,
  Search,
  MessageSquare,
  Bot,
  Layers,
  ChevronRight,
  Code2,
  Trash2,
  Copy,
  Check,
  Cpu,
  ShieldCheck,
  Server,
  Zap,
} from "lucide-react";
import { LiquidMetalButton } from "@/components/ui/liquid-metal-button";
import {
  AIInput,
  type AIInputMenuItem,
  type PromptSettingGroup,
} from "@/components/ui/ai-input";
import {
  checkBackendHealth,
  launchAgentRun,
  listAgentRuns,
  getAgentRunDetails,
  getAgentRunDiff,
  connectRunStream,
  createChatSession,
  listChatSessions,
  getChatSessionDetails,
  sendChatMessage,
  deleteChatSession,
} from "@/lib/api";
import type {
  AgentRun,
  AgentRunDetail,
  ChatSession,
  ChatSessionDetail,
  ExecutionStep,
  RunStatus,
  StreamEvent,
} from "@/types";

// Settings options for AIInput bottom command bar
const modelSettingGroups: PromptSettingGroup[] = [
  {
    id: "model",
    label: "Model",
    display: "featured",
    options: [
      {
        value: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "Fast sub-second ReAct loop",
      },
      {
        value: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        description: "Deep reasoning & architecture analysis",
      },
    ],
  },
  {
    id: "effort",
    label: "Effort",
    display: "submenu",
    options: [
      { value: "high", label: "High (15 iterations)" },
      { value: "medium", label: "Medium (10 iterations)" },
      { value: "low", label: "Low (5 iterations)" },
    ],
  },
];

const starterPrompts = [
  {
    title: "Fix ZeroDivisionError",
    prompt:
      "We have a math module at 'src/calculator.py'. Create the initial file with a divide function that currently crashes on zero division: 'def divide(a, b): return a / b'. Then fix it so divide(a, 0) safely returns None instead of raising ZeroDivisionError. Verify with python terminal execution, then call finish_task.",
    category: "Bug Fix",
  },
  {
    title: "Add Pytest Suite",
    prompt:
      "Create a utility file 'src/string_utils.py' with reverse_string and is_palindrome functions. Write comprehensive unit tests in 'tests/test_string_utils.py' and execute pytest in the terminal to verify 100% pass rate.",
    category: "Testing",
  },
  {
    title: "Stream Demuxing Refactor",
    prompt:
      "Inspect the codebase, create an isolated data parser in 'src/stream_parser.py' that processes incoming chunks with defensive error bounds, test it with sample inputs, and extract the git diff.",
    category: "Refactor",
  },
];

export default function CloudNativeDashboard() {
  // Navigation & mode state
  const [activeTab, setActiveTab] = useState<"runs" | "chats">("runs");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // Backend Health
  const [backendStatus, setBackendStatus] = useState<{
    online: boolean;
    latencyMs?: number;
    timestamp?: string;
  }>({ online: false });

  // Agent Runs state
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<AgentRunDetail | null>(null);
  const [liveSteps, setLiveSteps] = useState<ExecutionStep[]>([]);
  const [liveThoughts, setLiveThoughts] = useState<
    Array<{ step: number; content: string }>
  >([]);
  const [liveDiff, setLiveDiff] = useState<string>("");
  const [currentRunStatus, setCurrentRunStatus] = useState<RunStatus>("PENDING");
  const [isStreaming, setIsStreaming] = useState(false);

  // Chat Sessions state
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedChatDetail, setSelectedChatDetail] =
    useState<ChatSessionDetail | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);

  // UI helpers
  const [diffCopied, setDiffCopied] = useState(false);
  const activeSocketRef = useRef<WebSocket | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  // 1. Initial Data Fetching & Health Check
  const refreshHealth = useCallback(async () => {
    try {
      const health = await checkBackendHealth();
      setBackendStatus({
        online: true,
        latencyMs: health.latencyMs,
        timestamp: health.timestamp,
      });
    } catch {
      setBackendStatus({ online: false });
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const data = await listAgentRuns();
      setRuns(data);
    } catch (e) {
      console.warn("Could not list runs:", e);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const data = await listChatSessions();
      setChats(data);
    } catch (e) {
      console.warn("Could not list chats:", e);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    refreshRuns();
    refreshChats();

    const interval = setInterval(() => {
      refreshHealth();
    }, 15000);

    return () => clearInterval(interval);
  }, [refreshHealth, refreshRuns, refreshChats]);

  // 2. Select Run & Connect WebSocket if active
  const selectRun = useCallback(
    async (runId: string) => {
      setSelectedRunId(runId);
      setLiveThoughts([]);
      setLiveDiff("");

      // Close previous WebSocket if open
      if (activeSocketRef.current) {
        activeSocketRef.current.close();
        activeSocketRef.current = null;
      }

      try {
        const detail = await getAgentRunDetails(runId);
        setSelectedRunDetail(detail);
        setLiveSteps(detail.steps || []);
        setCurrentRunStatus(detail.status);
        if (detail.git_diff) {
          setLiveDiff(detail.git_diff);
        } else {
          const diffText = await getAgentRunDiff(runId);
          setLiveDiff(diffText);
        }

        // If the run is still RUNNING or PENDING, attach live WebSocket stream
        if (detail.status === "RUNNING" || detail.status === "PENDING") {
          setIsStreaming(true);
          const socket = connectRunStream(
            runId,
            (event: StreamEvent) => {
              if (event.event === "status") {
                setCurrentRunStatus(event.status);
              } else if (event.event === "thought") {
                setLiveThoughts((prev) => [
                  ...prev,
                  { step: event.step, content: event.content },
                ]);
              } else if (event.event === "tool_execution") {
                const newStep: ExecutionStep = {
                  step_number: event.step,
                  tool_name: event.tool,
                  tool_args: event.args,
                  tool_result: event.result,
                  created_at: new Date().toISOString(),
                };
                setLiveSteps((prev) => [...prev, newStep]);
              } else if (event.event === "finish") {
                setCurrentRunStatus(event.status);
                if (event.diff) setLiveDiff(event.diff);
                setIsStreaming(false);
                refreshRuns();
              }
            },
            () => setIsStreaming(false),
            () => setIsStreaming(false)
          );
          activeSocketRef.current = socket;
        } else {
          setIsStreaming(false);
        }
      } catch (err) {
        console.error("Failed to load run details:", err);
      }
    },
    [refreshRuns]
  );

  // 3. Select Chat Session
  const selectChat = useCallback(async (chatId: string) => {
    setSelectedChatId(chatId);
    try {
      const detail = await getChatSessionDetails(chatId);
      setSelectedChatDetail(detail);
    } catch (err) {
      console.error("Failed to load chat details:", err);
    }
  }, []);

  // 4. Handle Launching a New Run from AIInput
  const handleLaunchRun = async (
    prompt: string,
    modelName: string = "gemini-2.5-flash",
    effort: string = "high"
  ) => {
    const maxIterations = effort === "high" ? 15 : effort === "medium" ? 10 : 5;
    try {
      const newRun = await launchAgentRun({
        task_prompt: prompt,
        model_name: modelName,
        max_iterations: maxIterations,
      });

      // Update run list and auto-select
      setRuns((prev) => [newRun, ...prev]);
      setActiveTab("runs");
      await selectRun(newRun.id);
    } catch (err) {
      console.error("Failed to launch agent run:", err);
    }
  };

  // 5. Handle Sending Chat Message from AIInput
  const handleSendChat = async (content: string) => {
    if (!selectedChatId) {
      // Create new chat session first
      try {
        const newChat = await createChatSession({
          title: content.slice(0, 30) + (content.length > 30 ? "..." : ""),
        });
        setChats((prev) => [newChat, ...prev]);
        setSelectedChatId(newChat.id);

        setIsSendingChat(true);
        const reply = await sendChatMessage(newChat.id, content);
        setSelectedChatDetail({
          ...newChat,
          messages: [
            {
              id: "temp-user",
              session_id: newChat.id,
              role: "user",
              content,
              metadata_json: {},
              created_at: new Date().toISOString(),
            },
            reply,
          ],
        });
        setIsSendingChat(false);
      } catch (err) {
        console.error("Failed to create & send chat:", err);
        setIsSendingChat(false);
      }
      return;
    }

    // Existing chat
    try {
      setIsSendingChat(true);
      // Optimistic update
      setSelectedChatDetail((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: `user-${Date.now()}`,
              session_id: selectedChatId,
              role: "user",
              content,
              metadata_json: {},
              created_at: new Date().toISOString(),
            },
          ],
        };
      });

      const reply = await sendChatMessage(selectedChatId, content);
      setSelectedChatDetail((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          messages: [...prev.messages, reply],
        };
      });
      setIsSendingChat(false);
    } catch (err) {
      console.error("Failed to send chat message:", err);
      setIsSendingChat(false);
    }
  };

  // Dispatch from unified AIInput bottom bar
  const handleInputSubmit = (
    message: string,
    meta: { agent: string; settings: Record<string, string> }
  ) => {
    const model = meta.settings.model || "gemini-2.5-flash";
    const effort = meta.settings.effort || "high";

    if (activeTab === "runs") {
      handleLaunchRun(message, model, effort);
    } else {
      handleSendChat(message);
    }
  };

  const menuItems: AIInputMenuItem[] = [
    {
      value: "quick-zerodiv",
      label: "Fix ZeroDivision in calculator.py",
      icon: Terminal,
      shortcut: "⌘1",
      onClick: () =>
        handleLaunchRun(starterPrompts[0].prompt, "gemini-2.5-flash", "high"),
    },
    {
      value: "quick-pytest",
      label: "Generate Pytest Suite",
      icon: FileCode,
      shortcut: "⌘2",
      onClick: () =>
        handleLaunchRun(starterPrompts[1].prompt, "gemini-2.5-flash", "high"),
    },
    { value: "sep-1", type: "separator" },
    {
      value: "refresh-runs",
      label: "Refresh Execution History",
      icon: RotateCw,
      onClick: () => {
        refreshRuns();
        refreshChats();
      },
    },
  ];

  const handleCopyDiff = () => {
    if (liveDiff) {
      navigator.clipboard.writeText(liveDiff);
      setDiffCopied(true);
      setTimeout(() => setDiffCopied(false), 2000);
    }
  };

  // Filter items based on search query
  const filteredRuns = runs.filter(
    (r) =>
      r.task_prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredChats = chats.filter(
    (c) =>
      c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* ────────────────────────────────────────────────────────────────── */}
      {/* 1. SIDEBAR (sidebar-16 layout pattern)                             */}
      {/* ────────────────────────────────────────────────────────────────── */}
      <aside
        className={`flex flex-col border-r border-border bg-card/60 backdrop-blur-md transition-all duration-300 ${
          sidebarOpen ? "w-80" : "w-0 -translate-x-full"
        } relative z-30 overflow-hidden shrink-0`}
      >
        {/* Workspace Brand & Sandbox Resource Spec */}
        <div className="flex flex-col gap-2 border-b border-border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Bot className="size-4.5" />
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-sm tracking-tight">
                  Lakebase Harness
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Cloud-Native Sandbox
                </span>
              </div>
            </div>
            {/* Quick Action Button using LiquidMetalButton (icon mode) */}
            <LiquidMetalButton
              viewMode="icon"
              onClick={() => {
                if (activeTab === "runs") {
                  setSelectedRunId(null);
                  setSelectedRunDetail(null);
                } else {
                  createChatSession({ title: "New Conversation" }).then((c) => {
                    setChats((prev) => [c, ...prev]);
                    selectChat(c.id);
                  });
                }
              }}
            />
          </div>

          {/* Hardened Cgroup Badges */}
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1.5 text-[10px] text-muted-foreground border border-border/40">
            <div className="flex items-center gap-1">
              <Cpu className="size-3 text-brand" />
              <span>1.0 Core</span>
            </div>
            <div className="flex items-center gap-1">
              <ShieldCheck className="size-3 text-emerald-400" />
              <span>512 MB</span>
            </div>
            <div className="flex items-center gap-1">
              <Layers className="size-3 text-purple-400" />
              <span>64 PIDs</span>
            </div>
          </div>
        </div>

        {/* Tab Switcher: Autonomous Runs vs Multi-Turn Chats */}
        <div className="flex border-b border-border bg-muted/30 p-1.5">
          <button
            onClick={() => setActiveTab("runs")}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors ${
              activeTab === "runs"
                ? "bg-card text-foreground shadow-sm border border-border/60"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Terminal className="size-3.5" />
            <span>Sandbox Runs</span>
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-semibold">
              {runs.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("chats")}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors ${
              activeTab === "chats"
                ? "bg-card text-foreground shadow-sm border border-border/60"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MessageSquare className="size-3.5" />
            <span>Chats</span>
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-semibold">
              {chats.length}
            </span>
          </button>
        </div>

        {/* Search input */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder={`Search ${activeTab}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg bg-muted/50 border border-border/50 pl-8 pr-3 py-1.5 text-xs outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40 text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Item List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {activeTab === "runs" ? (
            filteredRuns.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No sandbox runs recorded yet. Launch a task below!
              </div>
            ) : (
              filteredRuns.map((r) => {
                const isSelected = selectedRunId === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => selectRun(r.id)}
                    className={`w-full text-left rounded-xl p-2.5 transition-all text-xs border ${
                      isSelected
                        ? "bg-primary/10 border-brand/50 shadow-sm"
                        : "hover:bg-accent/50 border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`size-2 rounded-full ${
                            r.status === "COMPLETED"
                              ? "bg-emerald-400"
                              : r.status === "RUNNING"
                              ? "bg-brand animate-pulse"
                              : r.status === "FAILED"
                              ? "bg-red-400"
                              : "bg-amber-400"
                          }`}
                        />
                        <span className="font-mono text-[10px] opacity-75">
                          {r.id.slice(0, 8)}
                        </span>
                      </div>
                      <span className="text-[10px] opacity-60">
                        {new Date(r.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-foreground/90 font-medium leading-relaxed">
                      {r.task_prompt}
                    </p>
                  </button>
                );
              })
            )
          ) : filteredChats.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No chat sessions. Start typing below!
            </div>
          ) : (
            filteredChats.map((c) => {
              const isSelected = selectedChatId === c.id;
              return (
                <div
                  key={c.id}
                  onClick={() => selectChat(c.id)}
                  className={`group flex items-center justify-between w-full rounded-xl p-2.5 transition-all text-xs border cursor-pointer ${
                    isSelected
                      ? "bg-primary/10 border-brand/50 text-foreground"
                      : "hover:bg-accent/50 border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{c.title}</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteChatSession(c.id).then(() => {
                        setChats((prev) => prev.filter((item) => item.id !== c.id));
                        if (selectedChatId === c.id) {
                          setSelectedChatId(null);
                          setSelectedChatDetail(null);
                        }
                      });
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-opacity"
                    title="Delete Chat"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Sidebar Footer with Trigger Button */}
        <div className="border-t border-border p-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Server className="size-3.5" />
            <span>FastAPI Uvicorn</span>
          </div>
          <LiquidMetalButton
            label="New Run"
            onClick={() => {
              setSelectedRunId(null);
              setSelectedRunDetail(null);
              setActiveTab("runs");
            }}
          />
        </div>
      </aside>

      {/* ────────────────────────────────────────────────────────────────── */}
      {/* 2. MAIN VIEWPORT WITH STICKY SITE HEADER                           */}
      {/* ────────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col h-full overflow-hidden">
        {/* STICKY SITE HEADER (sidebar-16 style) */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-card/80 backdrop-blur-md px-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              title="Toggle Sidebar"
            >
              <ChevronRight
                className={`size-4 transition-transform duration-200 ${
                  sidebarOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm tracking-tight text-foreground">
                Cloud-Native AI Harness
              </span>
              <span className="text-muted-foreground/60 text-xs font-mono">/</span>
              <span className="text-xs text-muted-foreground font-mono">
                {activeTab === "runs"
                  ? selectedRunId
                    ? `run-${selectedRunId.slice(0, 8)}`
                    : "overview"
                  : selectedChatDetail?.title || "chat"}
              </span>
            </div>
          </div>

          {/* Right Header: Server Health Badge, Model Indicator & Quick Launch */}
          <div className="flex items-center gap-3">
            {/* Backend connection pill */}
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs border ${
                backendStatus.online
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-red-500/10 text-red-400 border-red-500/30"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  backendStatus.online ? "bg-emerald-400" : "bg-red-400"
                }`}
              />
              <span className="font-medium text-[11px]">
                {backendStatus.online
                  ? `Backend Live (${backendStatus.latencyMs}ms)`
                  : "Backend Offline"}
              </span>
            </div>

            {/* Model Badge */}
            <div className="hidden sm:flex items-center gap-1 rounded-full bg-muted/60 border border-border px-2.5 py-1 text-[11px] text-muted-foreground font-medium">
              <Sparkles className="size-3 text-brand" />
              <span>Gemini 2.5 Flash</span>
            </div>

            {/* Header Action Button using LiquidMetalButton */}
            <LiquidMetalButton
              label="Launch Task"
              onClick={() => {
                setSelectedRunId(null);
                setSelectedRunDetail(null);
                setActiveTab("runs");
              }}
            />
          </div>
        </header>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* 3. DYNAMIC CONTENT AREA                                            */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {activeTab === "runs" ? (
            selectedRunId && selectedRunDetail ? (
              /* ACTIVE RUN DETAIL VIEW */
              <div className="mx-auto max-w-4xl space-y-6">
                {/* Run Metadata Header */}
                <div className="rounded-2xl border border-border bg-card p-5 shadow-sm space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                            currentRunStatus === "COMPLETED"
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                              : currentRunStatus === "RUNNING"
                              ? "bg-sky-500/20 text-sky-400 border border-sky-500/30 animate-pulse"
                              : currentRunStatus === "FAILED"
                              ? "bg-red-500/20 text-red-400 border border-red-500/30"
                              : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          }`}
                        >
                          {currentRunStatus}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">
                          ID: {selectedRunDetail.id}
                        </span>
                      </div>
                      <h2 className="text-base font-semibold text-foreground pt-1">
                        {selectedRunDetail.task_prompt}
                      </h2>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <LiquidMetalButton
                        viewMode="icon"
                        onClick={() => selectRun(selectedRunDetail.id)}
                      />
                    </div>
                  </div>

                  {selectedRunDetail.summary && (
                    <div className="rounded-xl bg-muted/60 border border-border/40 p-3 text-xs text-foreground/80 leading-relaxed">
                      <span className="font-semibold text-foreground">
                        Agent Conclusion:{" "}
                      </span>
                      {selectedRunDetail.summary}
                    </div>
                  )}
                </div>

                {/* Execution Trace Stepper */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                      <Terminal className="size-4 text-brand" />
                      <span>ReAct Execution Trace</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground font-mono">
                        {liveSteps.length} step(s)
                      </span>
                    </h3>

                    {isStreaming && (
                      <div className="flex items-center gap-1.5 text-xs text-brand animate-pulse">
                        <Zap className="size-3.5" />
                        <span>Live WebSocket Streaming...</span>
                      </div>
                    )}
                  </div>

                  {/* Live Reasoning Thoughts */}
                  {liveThoughts.length > 0 && (
                    <div className="space-y-2">
                      {liveThoughts.map((t, idx) => (
                        <div
                          key={idx}
                          className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 text-xs text-foreground/90 space-y-1"
                        >
                          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[11px]">
                            <Sparkles className="size-3" />
                            <span>Agent Reasoning (Step {t.step})</span>
                          </div>
                          <p className="whitespace-pre-wrap leading-relaxed font-sans">
                            {t.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Step Cards */}
                  <div className="space-y-3">
                    {liveSteps.map((step) => (
                      <div
                        key={step.step_number}
                        className="rounded-xl border border-border bg-card p-4 space-y-2.5 transition-all shadow-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="flex size-5 items-center justify-center rounded-full bg-brand/10 text-brand text-[11px] font-bold">
                              {step.step_number}
                            </span>
                            <span className="font-mono text-xs font-semibold text-foreground bg-muted px-2 py-0.5 rounded-md border border-border/50">
                              {step.tool_name}
                            </span>
                          </div>
                          <span className="text-[11px] text-muted-foreground">
                            {new Date(step.created_at).toLocaleTimeString()}
                          </span>
                        </div>

                        {/* Tool Arguments */}
                        {step.tool_args && Object.keys(step.tool_args).length > 0 && (
                          <div className="rounded-lg bg-black/40 border border-border/40 p-2.5 font-mono text-[11px] text-zinc-300 overflow-x-auto">
                            <span className="text-zinc-500 select-none">$ args: </span>
                            {JSON.stringify(step.tool_args, null, 2)}
                          </div>
                        )}

                        {/* Tool Result */}
                        {step.tool_result && (
                          <div className="rounded-lg bg-black/60 border border-border/50 p-2.5 font-mono text-[11px] text-zinc-200 overflow-x-auto">
                            <span className="text-zinc-500 select-none"># output: </span>
                            {typeof step.tool_result.content === "string" ? (
                              <pre className="whitespace-pre-wrap">
                                {step.tool_result.content}
                              </pre>
                            ) : typeof step.tool_result.stdout === "string" ? (
                              <pre className="whitespace-pre-wrap">
                                {String(
                                  step.tool_result.stdout ||
                                    step.tool_result.stderr ||
                                    "(exit code 0)"
                                )}
                              </pre>
                            ) : (
                              <pre className="whitespace-pre-wrap">
                                {JSON.stringify(step.tool_result, null, 2)}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={stepsEndRef} />
                  </div>
                </div>

                {/* Generated Unified Git Diff */}
                {liveDiff && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                        <Code2 className="size-4 text-purple-400" />
                        <span>Generated Unified Git Patch Diff</span>
                      </h3>
                      <button
                        onClick={handleCopyDiff}
                        className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors border border-border/60"
                      >
                        {diffCopied ? (
                          <>
                            <Check className="size-3 text-emerald-400" />
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="size-3" />
                            <span>Copy Diff</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className="rounded-xl border border-purple-500/30 bg-black/80 p-4 font-mono text-xs overflow-x-auto shadow-inner">
                      {liveDiff.split("\n").map((line, i) => (
                        <div
                          key={i}
                          className={`${
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "text-emerald-400 bg-emerald-500/10"
                              : line.startsWith("-") && !line.startsWith("---")
                              ? "text-rose-400 bg-rose-500/10"
                              : line.startsWith("@@")
                              ? "text-purple-400 font-bold"
                              : "text-zinc-300"
                          } px-1.5 rounded-sm`}
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* EMPTY STATE / STARTER DASHBOARD */
              <div className="mx-auto max-w-2xl py-8 space-y-8">
                <div className="text-center space-y-3">
                  <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-lg">
                    <Bot className="size-7" />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                    Autonomous Cloud-Native Coding Agent
                  </h1>
                  <p className="text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
                    Dispatches closed-loop ReAct reasoning agents into hardened,
                    air-gapped Docker sandboxes. Edits files, executes unit tests, and
                    delivers verified unified git diffs in seconds.
                  </p>
                </div>

                {/* Starter Task Cards */}
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Recommended Tasks
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {starterPrompts.map((item, idx) => (
                      <div
                        key={idx}
                        className="group flex flex-col justify-between rounded-xl border border-border bg-card p-4 hover:border-brand/50 transition-all cursor-pointer shadow-xs"
                        onClick={() =>
                          handleLaunchRun(item.prompt, "gemini-2.5-flash", "high")
                        }
                      >
                        <div className="space-y-1.5">
                          <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-semibold text-brand">
                            {item.category}
                          </span>
                          <h4 className="font-semibold text-xs text-foreground group-hover:text-brand transition-colors">
                            {item.title}
                          </h4>
                          <p className="text-[11px] text-muted-foreground line-clamp-3 leading-relaxed">
                            {item.prompt}
                          </p>
                        </div>
                        <div className="pt-3 flex items-center justify-end">
                          <LiquidMetalButton viewMode="icon" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          ) : (
            /* CONVERSATIONAL CHAT VIEW */
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="rounded-xl border border-border bg-card p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="size-4 text-brand" />
                  <span className="font-semibold text-sm">
                    {selectedChatDetail?.title || "Conversational Memory Thread"}
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Saved in Neon PostgreSQL
                </span>
              </div>

              {/* Chat Message Stream */}
              <div className="space-y-3 pb-8">
                {selectedChatDetail?.messages?.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl p-4 text-xs leading-relaxed space-y-1.5 ${
                        msg.role === "user"
                          ? "bg-brand/15 border border-brand/30 text-foreground"
                          : "bg-card border border-border text-foreground shadow-xs"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-semibold">
                        {msg.role === "user" ? (
                          <span>You</span>
                        ) : (
                          <div className="flex items-center gap-1 text-brand">
                            <Bot className="size-3" />
                            <span>Gemini Assistant</span>
                          </div>
                        )}
                        <span>•</span>
                        <span>{new Date(msg.created_at).toLocaleTimeString()}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}

                {isSendingChat && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-2xl bg-card border border-border p-4 text-xs text-muted-foreground">
                      <Sparkles className="size-4 text-brand animate-spin" />
                      <span>Gemini is generating response...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* 4. BOTTOM COMMAND INPUT BAR (AIInput)                              */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <div className="border-t border-border bg-card/80 backdrop-blur-md p-3 sm:p-4">
          <div className="mx-auto max-w-3xl">
            <AIInput
              settingGroups={modelSettingGroups}
              menuItems={menuItems}
              placeholder={
                activeTab === "runs"
                  ? "Describe a task or bug to fix in the isolated sandbox..."
                  : "Message conversational agent..."
              }
              onSend={handleInputSubmit}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
