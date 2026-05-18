import { useMemo } from "react";
import Filter from "ansi-to-html";

const ansiFilter = new Filter({
  fg: "#c8c8c8",
  bg: "#0a0e14",
  escapeXML: true,
  colors: [
    "#727272", // 0 Black → dim gray
    "#E53935", // 1 Red
    "#76B900", // 2 Green → NV green
    "#FFB800", // 3 Yellow → telemetry amber
    "#1E88E5", // 4 Blue
    "#FFB800", // 5 Magenta → yellow/amber (llama.cpp uses this for warnings)
    "#00e5ff", // 6 Cyan → telemetry cyan
    "#c8c8c8", // 7 White → light gray
    "#999999", // 8 Bright Black
    "#FF5252", // 9 Bright Red
    "#A0E700", // 10 Bright Green
    "#FFD600", // 11 Bright Yellow
    "#42A5F5", // 12 Bright Blue
    "#FF4081", // 13 Bright Magenta
    "#18FFFF", // 14 Bright Cyan
    "#ffffff", // 15 Bright White
  ],
});

// llama.cpp treats the ConPTY as a real terminal and emits non-SGR control sequences:
//   OSC window title (]0;...), DEC cursor show/hide (?25h/?25l), cursor positioning (H, f)
// ansi-to-html only handles SGR color codes ([...m). Everything else passes through as raw text.
// We strip non-SGR sequences here so the log output is clean while preserving colors.
// TODO: Investigate why llama.cpp sends terminal control codes to a ConPTY — may be related
// to LLAMA_LOG_COLORS=on or the pseudo-console itself. A --log-colors flag might help isolate.
const NON_SGR_RE = [
  /\x1b\].*?\x07/g,           // OSC sequences (window title, etc.) terminated by BEL (\x07)
  /\x1b\[[?0-9;]*[A-HJ-Kf]/g, // Cursor movement & screen control (H=cursor pos, J/K=erase, f=move)
  /\x1b\[\?[0-9;]*[hl]/g,     // DEC private modes (?25h=show cursor, ?25l=hide cursor)
];

function stripNonSgr(text: string): string {
  let result = text;
  for (const re of NON_SGR_RE) {
    result = result.replace(re, "");
  }
  return result;
}

interface AnsiTextProps {
  text: string;
}

export default function AnsiText({ text }: AnsiTextProps) {
  const html = useMemo(() => {
    const cleaned = stripNonSgr(text);
    return ansiFilter.toHtml(cleaned);
  }, [text]);

  return (
    <span
      className="inline"
      style={{ overflowWrap: "break-word" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
