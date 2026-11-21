/**
 * Data Contracts & Type Definitions
 * ---------------------------------
 * Mirrors FastAPI Pydantic models from Backend/controller/_routes.py
 */

export type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";


export interface ExecutionStep {
  step_number: number;
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_result: Record<string, unknown>;
  created_at: string;
}
export interface AgentRun {
  id: string;
  task_prompt: string;
  status: RunStatus;
  model_name: string;
  summary: string | null;
  git_diff: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AgentRunDetail extends AgentRun {
  steps: ExecutionStep[];
}

export interface ChatSession {
  id: string;
  title: string;
  model_name: string;
  system_prompt: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}


export interface ChatSessionDetail extends ChatSession {
  messages: ChatMessage[];
}

/**
 * WebSocket Live Event Payloads emitted by Backend
 */
export type StreamEvent =
  | { event: "status"; status: RunStatus }
  | { event: "thought"; step: number; content: string }
  | {
    event: "tool_execution";
    step: number;
    tool: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }
  | {
    event: "finish";
    status: RunStatus;
    summary: string;
    diff: string;
  };