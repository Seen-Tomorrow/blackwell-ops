import { invoke } from "@tauri-apps/api/core";
import {
  formatConsoleTimestamp,
  type OutputConsoleCategory,
} from "../lib/outputConsole";

interface OutputLine {
  timestamp: string;
  content: string;
  style: string;
}

async function readConsoleLines(category: OutputConsoleCategory): Promise<OutputLine[]> {
  return invoke<OutputLine[]>("get_blackwell_output_console_buffer_for_category", {
    category,
    limit: 900,
  });
}

function linesToText(lines: OutputLine[]): string {
  return (lines || [])
    .map((line) => `[${formatConsoleTimestamp(line.timestamp)}] ${line.content}`)
    .join("\n");
}

export async function clearOutputConsoleCategory(category: OutputConsoleCategory): Promise<void> {
  await invoke("clear_blackwell_output_console_category", { category });
}

export async function clearAllOutputConsoleBuffers(): Promise<void> {
  await invoke("clear_all_blackwell_output_console_buffers");
}

/** Copy the current category buffer as plain text; returns the line count. */
export async function copyOutputConsoleCategory(
  category: OutputConsoleCategory,
): Promise<number> {
  const lines = await readConsoleLines(category);
  const text = linesToText(lines);
  if (!text.trim()) throw new Error("Nothing to copy in this category.");

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    // WebView fallback for clipboard permission quirks.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Clipboard is unavailable.");
  }
  return lines.length;
}

/** Native Save As dialog; returns the saved path, or null when cancelled. */
export async function saveOutputConsoleCategory(
  category: OutputConsoleCategory,
): Promise<string | null> {
  const lines = await readConsoleLines(category);
  const content = linesToText(lines);
  if (!content.trim()) throw new Error("Nothing to save in this category.");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const defaultName = `blackwell-${category}-${stamp}.log`;
  return invoke<string | null>("save_output_console_text", { defaultName, content });
}

export async function openOutputConsoleLogsFolder(): Promise<string> {
  return invoke<string>("open_output_console_logs_folder");
}
