import { THREE_CDN } from "./playgroundCodegen";

const USES_THREE_RE = /\bTHREE\.|WebGLRenderer|three\.js/i;
const PG_BRIDGE_ID = "pg-console-bridge";

const CONSOLE_BRIDGE_SOURCE = `(function(){
  function send(level,args){try{parent.postMessage({type:'pg-console',level:level,msg:Array.prototype.map.call(args,String).join(' ')},'*');}catch(e){}}
  var o={log:console.log,warn:console.warn,error:console.error};
  console.log=function(){send('log',arguments);o.log.apply(console,arguments);};
  console.warn=function(){send('warn',arguments);o.warn.apply(console,arguments);};
  console.error=function(){send('error',arguments);o.error.apply(console,arguments);};
  window.addEventListener('error',function(e){
    var loc=e.lineno?(' line '+e.lineno+(e.colno?':'+e.colno:'')):'';
    send('error',[(e.message||'script error')+loc]);
  });
})();`;

let lastBlobUrl: string | null = null;

export function revokePreviewBlobUrl(): void {
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = null;
  }
}

function serializeDocument(doc: Document): string {
  const dt = doc.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`
    : "<!DOCTYPE html>\n";
  return doctype + doc.documentElement.outerHTML;
}

function parsePreviewDocument(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
}

function ensureHead(doc: Document): HTMLHeadElement {
  if (doc.head) return doc.head;
  const head = doc.createElement("head");
  doc.documentElement.insertBefore(head, doc.body ?? doc.documentElement.firstChild);
  return head;
}

function isThreeCdnScript(el: Element): boolean {
  if (el.tagName !== "SCRIPT") return false;
  const src = el.getAttribute("src") ?? "";
  return /three(\.min)?\.js/i.test(src) || /\/three\.js\//i.test(src);
}

/** DOM-safe: only remove real <script src=…three…> nodes — never regex inside inline JS strings. */
export function ensureThreeForPreview(html: string): string {
  if (!USES_THREE_RE.test(html)) return html;

  const doc = parsePreviewDocument(html);
  const head = ensureHead(doc);

  doc.querySelectorAll("script[src]").forEach((el) => {
    if (isThreeCdnScript(el)) el.remove();
  });

  const hasCanonical = [...head.querySelectorAll("script[src]")].some(
    (el) => el.getAttribute("src") === THREE_CDN,
  );
  if (!hasCanonical) {
    const loader = doc.createElement("script");
    loader.setAttribute("src", THREE_CDN);
    head.insertBefore(loader, head.firstChild);
  }

  return serializeDocument(doc);
}

export function injectConsoleBridge(html: string): string {
  const doc = parsePreviewDocument(html);
  const head = ensureHead(doc);

  if (doc.getElementById(PG_BRIDGE_ID)) {
    return serializeDocument(doc);
  }

  const bridge = doc.createElement("script");
  bridge.id = PG_BRIDGE_ID;
  bridge.textContent = CONSOLE_BRIDGE_SOURCE;

  const threeLoader = head.querySelector("script[src]");
  if (threeLoader?.nextSibling) {
    head.insertBefore(bridge, threeLoader.nextSibling);
  } else if (threeLoader) {
    head.appendChild(bridge);
  } else {
    head.insertBefore(bridge, head.firstChild);
  }

  return serializeDocument(doc);
}

export function preparePreviewHtml(html: string, captureConsole: boolean): string {
  let payload = ensureThreeForPreview(html);
  if (captureConsole) payload = injectConsoleBridge(payload);
  return payload;
}

export function renderPreviewInFrame(iframe: HTMLIFrameElement, html: string, captureConsole: boolean): void {
  const payload = preparePreviewHtml(html, captureConsole);
  revokePreviewBlobUrl();
  try {
    iframe.src = "about:blank";
    iframe.srcdoc = payload;
  } catch {
    const blob = new Blob([payload], { type: "text/html" });
    lastBlobUrl = URL.createObjectURL(blob);
    iframe.srcdoc = "";
    iframe.src = lastBlobUrl;
  }
}

export type PreviewConsoleLevel = "log" | "warn" | "error";

export interface PreviewConsoleLine {
  level: PreviewConsoleLevel;
  msg: string;
  ts: number;
}

export function isPreviewConsoleMessage(data: unknown): data is { type: "pg-console"; level: PreviewConsoleLevel; msg: string } {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "pg-console" && typeof d.msg === "string";
}