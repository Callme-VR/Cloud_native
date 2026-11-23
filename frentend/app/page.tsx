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
    "gemini-2.5-flash" | "gemini-2.5-pro"
  >("gemini-2.5-flash");
  const [selectedEffort, setSelectedEffort] = useState<
    "high" | "medium" | "low"
  >("high");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sockets & scroll refs
  const activeSocketRef = useRef<WebSocket | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
          sidebarOpen ? "w-80" : "w-0 -translate-x-full"
        } relative flex flex-col border-r border-border bg-card/60 backdrop-blur-md transition-all duration-300 ease-in-out shrink-0 overflow-hidden z-20`}
      >
        {/* Brand Header */}
        <div className="flex flex-col gap-3 p-4 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative size-8 shrink-0 overflow-hidden rounded-xl border border-primary/20 bg-muted/30 shadow-xs flex items-center justify-center">
                <Image
                  src="/nativebox-cube-orbit.svg"
                  alt="Cloud Native Logo"
                  width={28}
                  height={28}
                  className="object-cover"
                  priority
                />
              </div>
              <div className="flex flex-col">
                <span className="font-semibold text-sm tracking-tight text-foreground">
                  Cloud Native
                </span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  Autonomous Sandbox
                </span>
              </div>
            </div>

            {/* Quick Action Button using shadcn Button */}
            <Button
              variant="outline"
              size="icon-xs"
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
              title="New Item"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>

          {/* Hardened Cgroup Badges using shadcn Badge */}
          <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/50 p-1.5 text-[10px] text-muted-foreground border border-border/40">
            <div className="flex items-center justify-center gap-1 font-mono">
              <Cpu className="size-3 text-sky-400" />
              <span>1.0 CPU</span>
            </div>
            <div className="flex items-center justify-center gap-1 font-mono">
              <ShieldCheck className="size-3 text-emerald-400" />
              <span>512 MB</span>
            </div>
            <div className="flex items-center justify-center gap-1 font-mono">
              <Layers className="size-3 text-purple-400" />
              <span>64 PIDs</span>
            </div>
          </div>
        </div>

        {/* Tab Switcher: Autonomous Runs vs Multi-Turn Chats */}
        <div className="flex border-b border-border bg-muted/20 p-1 gap-1">
          <Button
            variant={activeTab === "runs" ? "default" : "ghost"}
            size="xs"
            className="flex-1 justify-center rounded-sm text-[11px]"
            onClick={() => setActiveTab("runs")}
          >
            <Terminal className="size-3" />
            <span>Sandbox Runs</span>
            <Badge
              variant="secondary"
              className="ml-1 px-1 py-0 text-[9px] bg-background/50"
            >
              {runs.length}
            </Badge>
          </Button>

          <Button
            variant={activeTab === "chats" ? "default" : "ghost"}
            size="xs"
            className="flex-1 justify-center rounded-sm text-[11px]"
            onClick={() => setActiveTab("chats")}
          >
            <MessageSquare className="size-3" />
            <span>Chats</span>
            <Badge
              variant="secondary"
              className="ml-1 px-1 py-0 text-[9px] bg-background/50"
            >
              {chats.length}
            </Badge>
          </Button>
        </div>

        {/* Search input using shadcn Input */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder={`Search ${activeTab}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 text-xs h-8 border-b-border"
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
                  <div
                    key={r.id}
                    onClick={() => selectRun(r.id)}
                    className={`group relative flex flex-col w-full text-left rounded-md p-2.5 transition-all text-xs border cursor-pointer ${
                      isSelected
                        ? "bg-primary/10 border-primary/50 shadow-xs"
                        : "hover:bg-muted/50 border-transparent text-muted-foreground hover:text-foreground"
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
                  className={`group flex items-center justify-between w-full rounded-md p-2.5 transition-all text-xs border cursor-pointer ${
                    isSelected
                      ? "bg-primary/10 border-primary/50 text-foreground"
                      : "hover:bg-muted/50 border-transparent text-muted-foreground hover:text-foreground"
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
        <div className="border-t border-border p-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
            <Server className="size-3.5" />
            <span>FastAPI Uvicorn</span>
          </div>
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              setSelectedRunId(null);
              setSelectedRunDetail(null);
              setActiveTab("runs");
            }}
          >
            <Plus className="size-3" />
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
              <div className="relative size-6 shrink-0 overflow-hidden rounded-md border border-border/60">
                <Image
                  src="/nativebox-cube-orbit.svg"
                  alt="Cloud Native Logo"
                  width={24}
                  height={24}
                  className="object-cover"
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

          {/* Right Header: Server Health Badge, Model Indicator & Quick Launch */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Backend connection pill */}
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border ${
                backendStatus.online
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/30"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  backendStatus.online ? "bg-emerald-400" : "bg-rose-400"
                }`}
              />
              <span className="font-medium text-[11px] font-mono">
                {backendStatus.online
                  ? `Live (${backendStatus.latencyMs}ms)`
                  : "Offline"}
              </span>
            </div>

            {/* Model Badge */}
            <div className="hidden sm:flex items-center gap-1 rounded-full bg-muted/60 border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground font-mono">
              <Sparkles className="size-3 text-sky-400" />
              <span>{selectedModel}</span>
            </div>

            {/* Header Action Button using shadcn Button */}
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setSelectedRunId(null);
                setSelectedRunDetail(null);
                setActiveTab("runs");
              }}
            >
              <Terminal className="size-3" />
              <span>Launch Task</span>
            </Button>
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
                <div className="text-center space-y-4">
                  <div className="relative mx-auto size-20 overflow-hidden rounded-2xl border border-primary/30 shadow-xl flex items-center justify-center bg-card">
                    <Image
                      src="/nativebox-cube-orbit.svg"
                      alt="Cloud Native Logo"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority
                    />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                    Cloud Native
                  </h1>
                  <p className="text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
                    Autonomous AI coding harness executing multi-turn ReAct reasoning
                    loops inside hardened, air-gapped Docker sandboxes with live
                    telemetry and Neon persistence.
                  </p>
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
                <span className="text-[11px] text-muted-foreground font-mono">
                  Saved in Neon PostgreSQL
                </span>
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
                            <div className="relative size-3.5 shrink-0 overflow-hidden rounded-full border border-primary/40">
                              <Image
                                src="/nativebox-cube-orbit.svg"
                                alt="Cloud Native"
                                width={14}
                                height={14}
                                className="object-cover"
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
        {/* 4. BOTTOM COMMAND CONSOLE USING SHADCN COMPONENTS                  */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <div className="border-t border-border bg-card/70 backdrop-blur-md p-3 sm:p-4">
          <div className="mx-auto max-w-3xl space-y-2">
            {/* Input Container */}
            <div className="relative rounded-lg border border-border bg-background/80 shadow-xs focus-within:border-primary/60 transition-colors p-2.5">
              <Textarea
                ref={textareaRef}
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleConsoleSubmit();
                  }
                }}
                placeholder={
                  activeTab === "runs"
                    ? "Describe a coding task, bug fix, or test to execute in the isolated Docker sandbox... (Ctrl+Enter to run)"
                    : "Message conversational memory agent... (Ctrl+Enter to send)"
                }
                className="w-full text-xs min-h-[60px] max-h-[160px] bg-transparent resize-none border-0 focus-visible:ring-0 p-0 shadow-none"
              />

              {/* Console Toolbar */}
              <div className="flex items-center justify-between pt-2 border-t border-border/40 text-xs">
                {/* Model & Effort Selector Pills */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Model Toggle */}
                  <div className="flex items-center rounded-sm bg-muted/60 p-0.5 border border-border/50 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setSelectedModel("gemini-2.5-flash")}
                      className={`px-2 py-0.5 rounded-xs transition-colors font-mono cursor-pointer ${
                        selectedModel === "gemini-2.5-flash"
                          ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Flash 2.5
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedModel("gemini-2.5-pro")}
                      className={`px-2 py-0.5 rounded-xs transition-colors font-mono cursor-pointer ${
                        selectedModel === "gemini-2.5-pro"
                          ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Pro 2.5
                    </button>
                  </div>

                  {/* Effort Toggle */}
                  <div className="flex items-center rounded-sm bg-muted/60 p-0.5 border border-border/50 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setSelectedEffort("high")}
                      className={`px-1.5 py-0.5 rounded-xs transition-colors font-mono cursor-pointer ${
                        selectedEffort === "high"
                          ? "bg-secondary text-secondary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title="15 Iterations"
                    >
                      High
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedEffort("medium")}
                      className={`px-1.5 py-0.5 rounded-xs transition-colors font-mono cursor-pointer ${
                        selectedEffort === "medium"
                          ? "bg-secondary text-secondary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title="10 Iterations"
                    >
                      Med
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedEffort("low")}
                      className={`px-1.5 py-0.5 rounded-xs transition-colors font-mono cursor-pointer ${
                        selectedEffort === "low"
                          ? "bg-secondary text-secondary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title="5 Iterations"
                    >
                      Low
                    </button>
                  </div>
                </div>

                {/* Submit Action Button using shadcn Button */}
                <div className="flex items-center gap-2">
                  <span className="hidden sm:inline text-[10px] text-muted-foreground font-mono">
                    ⌘+Enter
                  </span>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={handleConsoleSubmit}
                    isDisabled={!inputPrompt.trim() || isSubmitting || isSendingChat}
                  >
                    {isSubmitting || isSendingChat ? (
                      <RefreshCw className="size-3 animate-spin" />
                    ) : (
                      <Send className="size-3" />
                    )}
                    <span>
                      {activeTab === "runs" ? "Run Task" : "Send Message"}
                    </span>
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
