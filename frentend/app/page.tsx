"use client";

import Image from "next/image";
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
  Send,
  Plus,
  SlidersHorizontal,
  ChevronDown,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

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
  deleteAgentRun,
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

  // Autonomous Runs
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<AgentRunDetail | null>(null);
  const [liveSteps, setLiveSteps] = useState<ExecutionStep[]>([]);
  const [liveThoughts, setLiveThoughts] = useState<
    Array<{ step: number; content: string }>
  >([]);
  const [liveDiff, setLiveDiff] = useState<string>("");
  const [currentRunStatus, setCurrentRunStatus] =
    useState<RunStatus>("PENDING");
  const [isStreaming, setIsStreaming] = useState(false);
  const [diffCopied, setDiffCopied] = useState(false);

  // Conversational Chats
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedChatDetail, setSelectedChatDetail] =
    useState<ChatSessionDetail | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);

  // Command Console state
  const [inputPrompt, setInputPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState<
    "gemini-2.5-flash" | "gemini-3.5-flash-lite"
  >("gemini-2.5-flash");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState<
    "high" | "medium" | "low"
  >("high");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sockets & scroll refs
  const activeSocketRef = useRef<WebSocket | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 1. Initial Data Fetching
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
        } else if (detail.status === "COMPLETED") {
          const diffText = await getAgentRunDiff(runId);
          setLiveDiff(diffText);
        } else {
          setLiveDiff("");
        }

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

  // 4. Delete Handlers
  const handleDeleteRun = async (
    runId: string,
    e?: React.MouseEvent | React.SyntheticEvent
  ) => {
    e?.stopPropagation();
    try {
      await deleteAgentRun(runId);
      setRuns((prev) => prev.filter((r) => r.id !== runId));
      if (selectedRunId === runId) {
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        setLiveDiff("");
        setLiveSteps([]);
        setLiveThoughts([]);
      }
    } catch (err) {
      console.error("Failed to delete agent run:", err);
    }
  };

  const handleDeleteChat = async (
    chatId: string,
    e?: React.MouseEvent | React.SyntheticEvent
  ) => {
    e?.stopPropagation();
    try {
      await deleteChatSession(chatId);
      setChats((prev) => prev.filter((item) => item.id !== chatId));
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
        setSelectedChatDetail(null);
      }
    } catch (err) {
      console.error("Failed to delete chat session:", err);
    }
  };

  // 5. Handle Launching Runs
  const handleLaunchRun = async (
    prompt: string,
    modelName: string = selectedModel,
    effort: string = selectedEffort
  ) => {
    if (!prompt.trim() || isSubmitting) return;
    setIsSubmitting(true);
    const maxIterations =
      effort === "high" ? 15 : effort === "medium" ? 10 : 5;
    try {
      const newRun = await launchAgentRun({
        task_prompt: prompt,
        model_name: modelName,
        max_iterations: maxIterations,
      });

      setRuns((prev) => [newRun, ...prev]);
      setActiveTab("runs");
      setInputPrompt("");
      await selectRun(newRun.id);
    } catch (err) {
      console.error("Failed to launch agent run:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 6. Handle Sending Chat Messages
  const handleSendChat = async (content: string) => {
    if (!content.trim() || isSendingChat) return;
    setIsSendingChat(true);

    if (!selectedChatId) {
      try {
        const newChat = await createChatSession({
          title: content.slice(0, 30) + (content.length > 30 ? "..." : ""),
          model_name: selectedModel,
        });
        setChats((prev) => [newChat, ...prev]);
        setSelectedChatId(newChat.id);

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
        setInputPrompt("");
      } catch (err) {
        console.error("Failed to initialize chat session:", err);
      } finally {
        setIsSendingChat(false);
      }
    } else {
      try {
        setSelectedChatDetail((prev) =>
          prev
            ? {
                ...prev,
                messages: [
                  ...prev.messages,
                  {
                    id: "temp-user-" + Date.now(),
                    session_id: selectedChatId,
                    role: "user",
                    content,
                    metadata_json: {},
                    created_at: new Date().toISOString(),
                  },
                ],
              }
            : null
        );
        setInputPrompt("");

        const reply = await sendChatMessage(selectedChatId, content);
        setSelectedChatDetail((prev) =>
          prev ? { ...prev, messages: [...prev.messages, reply] } : null
        );
      } catch (err) {
        console.error("Failed to append message:", err);
      } finally {
        setIsSendingChat(false);
      }
    }
  };

  // 7. General Submit
  const handleConsoleSubmit = () => {
    if (!inputPrompt.trim()) return;
    if (activeTab === "runs") {
      handleLaunchRun(inputPrompt);
    } else {
      handleSendChat(inputPrompt);
    }
  };

  // 8. Auto-scroll on new steps
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveSteps, liveThoughts]);

  // Copy diff helper
  const handleCopyDiff = () => {
    if (!liveDiff) return;
    navigator.clipboard.writeText(liveDiff);
    setDiffCopied(true);
    setTimeout(() => setDiffCopied(false), 2000);
  };

  // Filtered lists for search
  const filteredRuns = runs.filter(
    (r) =>
      r.task_prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredChats = chats.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background font-sans text-foreground">
      {/* ────────────────────────────────────────────────────────────────── */}
      {/* 1. LEFT SIDEBAR: HARDENED CGROUP METRICS & EXECUTION LISTS         */}
      {/* ────────────────────────────────────────────────────────────────── */}
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-0 -translate-x-full border-r-0"
        } relative flex flex-col border-r border-border/70 bg-muted/25 backdrop-blur-md transition-all duration-300 ease-in-out shrink-0 overflow-hidden z-20`}
      >
        {/* Brand Header */}
        <div className="flex flex-col gap-3 px-3.5 pt-3.5 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative size-8 shrink-0 flex items-center justify-center">
                <Image
                  src="/cloud-native-logo.svg"
                  alt="Cloud Native Logo"
                  width={32}
                  height={32}
                  className="object-contain"
                  priority
                />
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-sm tracking-tight text-foreground leading-tight">
                  Cloud Native
                </span>
                <span className="text-[11px] text-muted-foreground/80 font-medium">
                  Autonomous Sandbox
                </span>
              </div>
            </div>
          </div>

          {/* Hardened Cgroup Metrics */}
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-background/70 px-2 py-1.5 text-[10px] text-muted-foreground border border-border/50 shadow-2xs">
            <div className="flex items-center justify-center gap-1 font-mono">
              <Cpu className="size-3 text-sky-500" />
              <span>1.0 CPU</span>
            </div>
            <div className="flex items-center justify-center gap-1 font-mono border-x border-border/40">
              <ShieldCheck className="size-3 text-emerald-500" />
              <span>512 MB</span>
            </div>
            <div className="flex items-center justify-center gap-1 font-mono">
              <Layers className="size-3 text-violet-500" />
              <span>64 PIDs</span>
            </div>
          </div>
        </div>

        {/* Segmented Tab Switcher */}
        <div className="px-3 pb-2.5">
          <div className="grid grid-cols-2 rounded-xl bg-muted/70 p-1 gap-1 border border-border/40">
            <button
              type="button"
              onClick={() => setActiveTab("runs")}
              className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs transition-all cursor-pointer ${
                activeTab === "runs"
                  ? "bg-background text-foreground font-medium shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Terminal className="size-3.5 shrink-0" />
              <span>Runs</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono ${
                  activeTab === "runs"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "bg-background/60 text-muted-foreground"
                }`}
              >
                {runs.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("chats")}
              className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs transition-all cursor-pointer ${
                activeTab === "chats"
                  ? "bg-background text-foreground font-medium shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span>Chats</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono ${
                  activeTab === "chats"
                    ? "bg-primary/10 text-primary font-semibold"
                    : "bg-background/60 text-muted-foreground"
                }`}
              >
                {chats.length}
              </span>
            </button>
          </div>
        </div>

        {/* Search Input */}
        <div className="px-3 pb-2.5">
          <div className="relative flex items-center rounded-xl bg-background/75 border border-border/60 focus-within:border-primary/40 transition-colors px-2.5">
            <Search className="size-3.5 text-muted-foreground/80 shrink-0" />
            <Input
              type="text"
              placeholder={`Search ${activeTab}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-2 pr-1 text-xs h-8 border-0 border-b-0 focus-visible:border-b-0 focus-visible:ring-0 bg-transparent"
            />
          </div>
        </div>

        {/* Item List */}
        <div className="flex-1 overflow-y-auto px-2.5 py-1 space-y-1">
          {activeTab === "runs" ? (
            filteredRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-2">
                <div className="size-8 rounded-full bg-muted/70 flex items-center justify-center text-muted-foreground/70">
                  <Terminal className="size-4" />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  No sandbox runs yet. Launch a task below!
                </p>
              </div>
            ) : (
              filteredRuns.map((r) => {
                const isSelected = selectedRunId === r.id;
                return (
                  <div
                    key={r.id}
                    onClick={() => selectRun(r.id)}
                    className={`group relative flex flex-col w-full text-left rounded-xl p-2.5 transition-all text-xs border cursor-pointer ${
                      isSelected
                        ? "bg-background border-primary/40 shadow-xs text-foreground"
                        : "hover:bg-background/60 border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`size-2 rounded-full ${
                            r.status === "COMPLETED"
                              ? "bg-emerald-400"
                              : r.status === "RUNNING"
                              ? "bg-sky-400 animate-pulse"
                              : r.status === "FAILED"
                              ? "bg-rose-400"
                              : "bg-amber-400"
                          }`}
                        />
                        <span className="font-mono text-[10px] opacity-75">
                          {r.id.slice(0, 8)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] opacity-60">
                          {new Date(r.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <button
                          onClick={(e) => handleDeleteRun(r.id, e)}
                          className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-rose-400 text-muted-foreground transition-opacity"
                          title="Delete Run"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </div>
                    <p className="line-clamp-2 text-foreground/90 font-medium leading-relaxed pr-2">
                      {r.task_prompt}
                    </p>
                  </div>
                );
              })
            )
          ) : filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center gap-2">
              <div className="size-8 rounded-full bg-muted/70 flex items-center justify-center text-muted-foreground/70">
                <MessageSquare className="size-4" />
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                No chat sessions. Start typing below!
              </p>
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
                      ? "bg-background border-primary/40 shadow-xs text-foreground"
                      : "hover:bg-background/60 border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{c.title}</span>
                  </div>
                  <button
                    onClick={(e) => handleDeleteChat(c.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 text-muted-foreground transition-opacity"
                    title="Delete Chat"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Sidebar Footer with Trigger Button */}
        <div className="p-3">
          <Button
            size="sm"
            variant="default"
            className="w-full justify-center rounded-xl normal-case tracking-normal font-medium shadow-xs"
            onClick={() => {
              setSelectedRunId(null);
              setSelectedRunDetail(null);
              setActiveTab("runs");
            }}
          >
            <Plus className="size-3.5" />
            <span>New Run</span>
          </Button>
        </div>
      </aside>

      {/* ────────────────────────────────────────────────────────────────── */}
      {/* 2. MAIN WORKSPACE AREA                                             */}
      {/* ────────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden bg-background">
        {/* Top Navigation Bar */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-card/40 px-4 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon-xs"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title="Toggle Sidebar"
            >
              <ChevronRight
                className={`size-3.5 transition-transform duration-200 ${
                  sidebarOpen ? "rotate-180" : ""
                }`}
              />
            </Button>

            <div className="flex items-center gap-2.5">
              <div className="relative size-6 shrink-0 flex items-center justify-center">
                <Image
                  src="/cloud-native-logo.svg"
                  alt="Cloud Native Logo"
                  width={24}
                  height={24}
                  className="object-contain"
                />
              </div>
              <span className="font-semibold text-sm tracking-tight text-foreground">
                Cloud Native
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
        </header>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* 3. DYNAMIC CONTENT AREA                                            */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {activeTab === "runs" ? (
            selectedRunId && selectedRunDetail ? (
              /* ACTIVE RUN DETAIL VIEW */
              <div className="mx-auto max-w-4xl space-y-6">
                {/* Run Metadata Header Card */}
                <Card className="rounded-xl border border-border bg-card p-5 shadow-xs space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider font-mono ${
                            currentRunStatus === "COMPLETED"
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                              : currentRunStatus === "RUNNING"
                              ? "bg-sky-500/20 text-sky-400 border border-sky-500/30 animate-pulse"
                              : currentRunStatus === "FAILED"
                              ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
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
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => handleDeleteRun(selectedRunDetail.id)}
                        className="rounded-md"
                        title="Delete Task"
                      >
                        <Trash2 className="size-3" />
                        <span>Delete Task</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={() => selectRun(selectedRunDetail.id)}
                        title="Refresh Run"
                      >
                        <RefreshCw className="size-3" />
                      </Button>
                    </div>
                  </div>

                  {selectedRunDetail.summary && (
                    <div className="rounded-md bg-muted/60 border border-border/40 p-3 text-xs text-foreground/80 leading-relaxed">
                      <span className="font-semibold text-foreground">
                        Agent Conclusion:{" "}
                      </span>
                      {selectedRunDetail.summary}
                    </div>
                  )}
                </Card>

                {/* Execution Trace Stepper */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                      <Terminal className="size-4 text-sky-400" />
                      <span>ReAct Execution Trace</span>
                      <Badge
                        variant="secondary"
                        className="px-2 py-0 text-xs font-mono"
                      >
                        {liveSteps.length} step(s)
                      </Badge>
                    </h3>

                    {isStreaming && (
                      <div className="flex items-center gap-1.5 text-xs text-sky-400 animate-pulse font-mono">
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
                          className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5 text-xs text-foreground/90 space-y-1"
                        >
                          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[11px] font-mono">
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
                      <Card
                        key={step.step_number}
                        className="rounded-lg border border-border bg-card p-4 space-y-2.5 transition-all shadow-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold font-mono">
                              {step.step_number}
                            </span>
                            <span className="font-mono text-xs font-semibold text-foreground bg-muted px-2 py-0.5 rounded-sm border border-border/50">
                              {step.tool_name}
                            </span>
                          </div>
                          <span className="text-[11px] text-muted-foreground font-mono">
                            {new Date(step.created_at).toLocaleTimeString()}
                          </span>
                        </div>

                        {/* Tool Arguments */}
                        {step.tool_args &&
                          Object.keys(step.tool_args).length > 0 && (
                            <div className="rounded-md bg-black/40 border border-border/40 p-2.5 font-mono text-[11px] text-zinc-300 overflow-x-auto">
                              <span className="text-zinc-500 select-none">$ args: </span>
                              {JSON.stringify(step.tool_args, null, 2)}
                            </div>
                          )}

                        {/* Tool Result */}
                        {step.tool_result && (
                          <div className="rounded-md bg-black/60 border border-border/50 p-2.5 font-mono text-[11px] text-zinc-200 overflow-x-auto">
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
                      </Card>
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
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={handleCopyDiff}
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
                      </Button>
                    </div>

                    <div className="rounded-lg border border-purple-500/30 bg-black/80 p-4 font-mono text-xs overflow-x-auto shadow-inner">
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
                          } px-1.5 rounded-xs`}
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
                <div className="text-center">
                  <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                    Cloud Native
                  </h1>
                </div>

                {/* Starter Task Cards using shadcn Card */}
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    Recommended Tasks
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {starterPrompts.map((item, idx) => (
                      <Card
                        key={idx}
                        className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-all cursor-pointer shadow-xs"
                        onClick={() =>
                          handleLaunchRun(item.prompt, selectedModel, selectedEffort)
                        }
                      >
                        <div className="space-y-2">
                          <Badge variant="secondary" className="text-[10px]">
                            {item.category}
                          </Badge>
                          <h4 className="font-semibold text-xs text-foreground group-hover:text-primary transition-colors">
                            {item.title}
                          </h4>
                          <p className="text-[11px] text-muted-foreground line-clamp-3 leading-relaxed">
                            {item.prompt}
                          </p>
                        </div>
                        <div className="pt-3 flex items-center justify-end">
                          <Button size="icon-xs" variant="ghost">
                            <Play className="size-3 text-primary" />
                          </Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              </div>
            )
          ) : (
            /* CONVERSATIONAL CHAT VIEW */
            <div className="mx-auto max-w-3xl space-y-4">
              <Card className="rounded-lg border border-border bg-card p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="size-4 text-sky-400" />
                  <span className="font-semibold text-sm">
                    {selectedChatDetail?.title || "Conversational Memory Thread"}
                  </span>
                </div>
              </Card>

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
                      className={`max-w-[80%] rounded-xl p-4 text-xs leading-relaxed space-y-1.5 ${
                        msg.role === "user"
                          ? "bg-primary/15 border border-primary/30 text-foreground"
                          : "bg-card border border-border text-foreground shadow-xs"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-semibold">
                        {msg.role === "user" ? (
                          <span>You</span>
                        ) : (
                          <div className="flex items-center gap-1.5 text-primary">
                            <div className="relative size-4 shrink-0 flex items-center justify-center">
                              <Image
                                src="/cloud-native-logo.svg"
                                alt="Cloud Native"
                                width={16}
                                height={16}
                                className="object-contain"
                              />
                            </div>
                            <span>Cloud Native Assistant</span>
                          </div>
                        )}
                        <span>•</span>
                        <span className="font-mono">
                          {new Date(msg.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}

                {isSendingChat && (
                  <div className="flex justify-start">
                    <Card className="flex items-center gap-2 rounded-xl bg-card border border-border p-4 text-xs text-muted-foreground">
                      <Sparkles className="size-4 text-primary animate-spin" />
                      <span>Gemini is generating response...</span>
                    </Card>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* 4. BOTTOM FLOATING INPUT BOX                                       */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <div className="px-4 pb-4 pt-1">
          <div className="mx-auto max-w-2xl">
            <div className="relative rounded-2xl border border-border bg-card shadow-sm focus-within:border-primary/50 transition-colors px-4 py-3">
              <Textarea
                ref={textareaRef}
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleConsoleSubmit();
                  }
                }}
                placeholder={
                  activeTab === "runs"
                    ? "How can I help you today?"
                    : "Message conversational agent..."
                }
                className="w-full text-sm min-h-[32px] max-h-[120px] bg-transparent resize-none border-0 border-b-0 focus-visible:border-b-0 focus-visible:ring-0 p-0 shadow-none"
              />

              {/* Bottom Bar (no divider line) */}
              <div className="flex items-center justify-between pt-2 text-xs">
                {/* Left: Clean Mode Pill (Runs / Chat) */}
                <div className="flex items-center rounded-lg bg-muted/60 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setActiveTab("runs")}
                    className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                      activeTab === "runs"
                        ? "bg-background text-foreground font-medium shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Sandbox
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("chats")}
                    className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                      activeTab === "chats"
                        ? "bg-background text-foreground font-medium shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Chat
                  </button>
                </div>

                {/* Right: Model Popup Selector & Effort + Send */}
                <div className="flex items-center gap-2">
                  <div className="relative" ref={modelMenuRef}>
                    <button
                      type="button"
                      onClick={() => setModelMenuOpen((prev) => !prev)}
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                      title="Select Model"
                    >
                      <span>
                        {selectedModel === "gemini-2.5-flash"
                          ? "Gemini 2.5 Flash"
                          : "Gemini 3.5 Flash-Lite"}
                      </span>
                      <ChevronDown className="size-3 opacity-70" />
                    </button>

                    {modelMenuOpen && (
                      <div className="absolute bottom-full right-0 mb-2 w-60 rounded-xl border border-border bg-popover p-1.5 shadow-lg z-50">
                        {[
                          {
                            id: "gemini-2.5-flash" as const,
                            label: "Gemini 2.5 Flash",
                            desc: "Balanced speed & reasoning",
                          },
                          {
                            id: "gemini-3.5-flash-lite" as const,
                            label: "Gemini 3.5 Flash-Lite",
                            desc: "Ultra-fast lightweight model",
                          },
                        ].map((m) => {
                          const active = selectedModel === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                setSelectedModel(m.id);
                                setModelMenuOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors cursor-pointer ${
                                active
                                  ? "bg-primary/10 text-foreground"
                                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                              }`}
                            >
                              <div className="flex flex-col">
                                <span className="text-xs font-medium text-foreground">
                                  {m.label}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {m.desc}
                                </span>
                              </div>
                              {active && (
                                <Check className="size-3.5 text-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setSelectedEffort(
                        selectedEffort === "high"
                          ? "medium"
                          : selectedEffort === "medium"
                          ? "low"
                          : "high"
                      )
                    }
                    className="rounded-lg px-1.5 py-1 text-[11px] text-muted-foreground/80 hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer capitalize"
                    title="Switch Effort"
                  >
                    {selectedEffort === "medium" ? "Med" : selectedEffort}
                  </button>

                  <Button
                    size="icon-xs"
                    variant="default"
                    className="rounded-lg"
                    onClick={handleConsoleSubmit}
                    isDisabled={!inputPrompt.trim() || isSubmitting || isSendingChat}
                    title={activeTab === "runs" ? "Run Task" : "Send Message"}
                  >
                    {isSubmitting || isSendingChat ? (
                      <RefreshCw className="size-3.5 animate-spin" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
