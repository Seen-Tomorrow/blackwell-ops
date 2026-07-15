import { invoke } from "@tauri-apps/api/core";
import { formatConsoleTimestamp, type OutputConsoleCategory } from "./BlackwellOutputConsole";

interface OutputLine {
  timestamp: string;
  content: string;
  style: string;
}

export async function clearOutputConsoleCategory(category: OutputConsoleCategory): Promise<void> {
  await invoke("clear_blackwell_output_console_category", { category });
}

export async function clearAllOutputConsoleBuffers(): Promise<void> {
  await invoke("clear_all_blackwell_output_console_buffers");
}

export async function saveOutputConsoleCategory(category: OutputConsoleCategory): Promise<void> {
  const lines = await invoke<OutputLine[]>("get_blackwell_output_console_buffer_for_category", {
    category,
    limit: 900,
  });
  const content = (lines || [])
    .map((line) => `[${formatConsoleTimestamp(line.timestamp)}] ${line.content}`)
    .join("\n");
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `blackwell-${category}-${new Date().toISOString().slice(0, 19)}.log`;
  a.click();
  URL.revokeObjectURL(url);
}