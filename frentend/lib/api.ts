/**
 * API Client & Real-Time Streaming Gateway
 * -----------------------------------------
 * Connects the Next.js frontend to the FastAPI Cloud-Native Agent Backend.
 */

import type {
  AgentRun,
  AgentRunDetail,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  StreamEvent,
} from "@/types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_URL || "ws://127.0.0.1:8000";

/**
 * Health Check to verify server connectivity & latency
 */
export async function checkBackendHealth(): Promise<{
  status: string;
  service: string;
  timestamp: string;
  latencyMs: number;
}> {
  const start = performance.now();
  const res = await fetch(`${API_BASE_URL}/health`, {
    cache: "no-store",
  });
  const latencyMs = Math.round(performance.now() - start);
  if (!res.ok) {
    throw new Error(`Health check failed with status: ${res.status}`);
  }
  const data = await res.json();
  return { ...data, latencyMs };
}

// ==========================================
// Agent Runs (Autonomous Sandbox Tasks)
// ==========================================

export async function launchAgentRun(payload: {
  task_prompt: string;
  model_name?: string;
  max_iterations?: number;
}): Promise<AgentRun> {
  const res = await fetch(`${API_BASE_URL}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_prompt: payload.task_prompt,
      model_name: payload.model_name || "gemini-2.5-flash",
      max_iterations: payload.max_iterations ?? 12,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to launch run: ${errorText || res.statusText}`);
  }

  return res.json();
}

export async function listAgentRuns(): Promise<AgentRun[]> {
  const res = await fetch(`${API_BASE_URL}/api/runs`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch runs: ${res.statusText}`);
  }

  return res.json();
}

export async function getAgentRunDetails(runId: string): Promise<AgentRunDetail> {
  const res = await fetch(`${API_BASE_URL}/api/runs/${runId}`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch run details for ${runId}: ${res.statusText}`);
  }

  return res.json();
}

export async function getAgentRunDiff(runId: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/runs/${runId}/diff`, {
    cache: "no-store",
  });

  if (!res.ok) {
    return "";
  }

  const data = await res.json();
  return data.patch || "";
}

/**
 * Connects to the WebSocket channel for real-time telemetry streaming
 */
export function connectRunStream(
  runId: string,
  onEvent: (event: StreamEvent) => void,
  onError?: (err: Event) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = `${WS_BASE_URL}/api/runs/${runId}/stream`;
  const socket = new WebSocket(wsUrl);

  socket.onmessage = (event) => {
    try {
      const data: StreamEvent = JSON.parse(event.data);
      onEvent(data);
    } catch (e) {
      console.error("Failed to parse WebSocket stream event:", e);
    }
  };

  if (onError) socket.onerror = onError;
  if (onClose) socket.onclose = onClose;

  return socket;
}

// ==========================================
// Conversational Chat Sessions
// ==========================================

export async function createChatSession(payload: {
  title?: string;
  model_name?: string;
  system_prompt?: string;
  project_id?: string;
}): Promise<ChatSession> {
  const res = await fetch(`${API_BASE_URL}/api/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload.title || "New Task Chat",
      model_name: payload.model_name || "gemini-2.5-flash",
      system_prompt: payload.system_prompt || null,
      project_id: payload.project_id || null,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create chat: ${res.statusText}`);
  }

  return res.json();
}

export async function listChatSessions(
  limit: number = 50,
  offset: number = 0
): Promise<ChatSession[]> {
  const res = await fetch(
    `${API_BASE_URL}/api/chats?limit=${limit}&offset=${offset}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error(`Failed to list chats: ${res.statusText}`);
  }

  return res.json();
}

export async function getChatSessionDetails(
  chatId: string
): Promise<ChatSessionDetail> {
  const res = await fetch(`${API_BASE_URL}/api/chats/${chatId}`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Failed to get chat ${chatId}: ${res.statusText}`);
  }

  return res.json();
}

export async function updateChatSession(
  chatId: string,
  payload: { title?: string; model_name?: string; system_prompt?: string }
): Promise<ChatSession> {
  const res = await fetch(`${API_BASE_URL}/api/chats/${chatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to update chat ${chatId}: ${res.statusText}`);
  }

  return res.json();
}

export async function deleteChatSession(chatId: string): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/api/chats/${chatId}`, {
    method: "DELETE",
  });

  return res.ok;
}

export async function sendChatMessage(
  chatId: string,
  content: string
): Promise<ChatMessage> {
  const res = await fetch(`${API_BASE_URL}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to send message: ${errorText || res.statusText}`);
  }

  return res.json();
}
