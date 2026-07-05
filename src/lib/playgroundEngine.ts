import { buildChatMessages, buildPromptForModel, type ChatMessage } from "./playgroundCodegen";
import type { PlaygroundChatTurn } from "./storage";

export interface EngineCompletionOptions {
  port: number;
  userText: string;
  previousCode: string;
  history: PlaygroundChatTurn[];
  temperature: number;
  nPredict: number;
  maxPredict: number;
  useChatApi: boolean;
  maxCtxChars?: number;
  signal: AbortSignal;
  onChunk?: (partial: string) => void;
}

function clampPredict(n: number, max: number): number {
  return Math.max(128, Math.min(max, n));
}

function parseStreamChunk(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "data: [DONE]" || trimmed === "[DONE]") return "";

  const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!jsonStr.startsWith("{")) return "";

  try {
    const j = JSON.parse(jsonStr) as Record<string, unknown>;
    const choices = j.choices as Array<Record<string, unknown>> | undefined;
    if (choices?.[0]) {
      const ch = choices[0];
      const delta = ch.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") return delta.content;
      if (typeof ch.text === "string") return ch.text;
      const msg = ch.message as Record<string, unknown> | undefined;
      if (typeof msg?.content === "string") return msg.content;
    }
    if (typeof j.content === "string") return j.content;
    if (typeof j.token === "string") return j.token;
    if (typeof j.generation === "string") return j.generation;
  } catch {
    // ignore malformed chunk
  }
  return "";
}

function extractCompletionText(json: Record<string, unknown>): string {
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const ch = choices[0];
    const msg = ch.message as Record<string, unknown> | undefined;
    const fromMsg = msg?.content ?? ch.text ?? (ch.delta as Record<string, unknown> | undefined)?.content;
    if (fromMsg != null) return String(fromMsg);
  }
  for (const key of ["content", "generation", "response", "text", "output"] as const) {
    if (json[key] != null) return String(json[key]);
  }
  return "";
}

async function readStreamResponse(resp: Response, onChunk?: (partial: string) => void): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const text = await resp.text();
    onChunk?.(text);
    return text;
  }

  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const piece = parseStreamChunk(line);
      if (piece) {
        full += piece;
        onChunk?.(full);
      }
    }
  }

  if (buffer.trim()) {
    const piece = parseStreamChunk(buffer);
    if (piece) {
      full += piece;
      onChunk?.(full);
    }
  }

  return full;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  stream: boolean,
  onChunk?: (partial: string) => void,
): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream }),
    signal,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Engine HTTP ${resp.status}: ${txt.slice(0, 200) || "no body"}`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  if (stream && (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson"))) {
    return readStreamResponse(resp, onChunk);
  }

  if (stream && resp.body) {
    return readStreamResponse(resp, onChunk);
  }

  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const text = extractCompletionText(json);
  onChunk?.(text);
  return text;
}

async function tryChatCompletion(opts: EngineCompletionOptions): Promise<string | null> {
  const messages: ChatMessage[] = buildChatMessages(
    opts.userText,
    opts.previousCode,
    opts.history,
    opts.maxCtxChars,
  );
  const url = `http://127.0.0.1:${opts.port}/v1/chat/completions`;
  const body = {
    messages,
    temperature: Math.max(0, Math.min(2, opts.temperature)),
    max_tokens: clampPredict(opts.nPredict, opts.maxPredict),
    cache_prompt: false,
  };

  try {
    return await postJson(url, body, opts.signal, true, opts.onChunk);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404|405|501/.test(msg)) return null;
    throw err;
  }
}

async function completionFallback(opts: EngineCompletionOptions): Promise<string> {
  const prompt = buildPromptForModel(
    opts.userText,
    opts.previousCode,
    opts.history,
    opts.maxCtxChars,
  );
  const url = `http://127.0.0.1:${opts.port}/completion`;
  const body = {
    prompt,
    n_predict: clampPredict(opts.nPredict, opts.maxPredict),
    temperature: Math.max(0, Math.min(2, opts.temperature)),
    cache_prompt: false,
  };
  return postJson(url, body, opts.signal, true, opts.onChunk);
}

export async function streamEngineGeneration(opts: EngineCompletionOptions): Promise<string> {
  if (opts.useChatApi) {
    const chat = await tryChatCompletion(opts);
    if (chat != null) return chat;
  }
  return completionFallback(opts);
}