import type { PlaygroundChatTurn } from "./storage";

/** three.js UMD build on cdnjs — exposes global THREE (r134 is the newest tagged build there). */
export const THREE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js";

export const PLAYGROUND_MAX_CODE_CHARS = 200_000;
export const PLAYGROUND_MAX_PROMPT_CODE_CHARS = 14_000;
export const PLAYGROUND_HISTORY_TURNS_FOR_PROMPT = 6;
export const PLAYGROUND_ASSISTANT_SLICE = 1200;

export const CODEGEN_SYSTEM = `You are an expert creative coder specializing in standalone browser demos.
Rules:
- The final answer must be a SINGLE complete, self-contained HTML5 document.
- Start the document with <!DOCTYPE html>.
- Load three.js from this exact CDN: ${THREE_CDN}
- The page must work when loaded directly or inside a sandboxed iframe (no external files besides the CDN script).
- Use <canvas id="c">, THREE.WebGLRenderer, requestAnimationFrame.
- Provide basic mouse/keyboard/touch controls appropriate for the demo.
- Keep the code clean and reasonably commented.
- After any brief thinking or description, output the complete runnable HTML inside one \`\`\`html fenced code block.
- Never omit the closing \`\`\`.
If the user asks to modify an existing demo, return the FULL updated HTML document (again wrapped in a single \`\`\`html block).`;

export const PLAYGROUND_PRESETS: { label: string; prompt: string; kind: "three" | "canvas" | "p5" | "webgpu" }[] = [
  {
    label: "3D endless runner",
    kind: "three",
    prompt:
      "Build a 3D endless runner with three.js. Player auto-forwards, jump on space, avoid obstacles.",
  },
  {
    label: "Physics sandbox",
    kind: "three",
    prompt:
      "Create a minimal 3D physics sandbox: click to spawn cubes that stack and roll with basic gravity.",
  },
  {
    label: "Low-poly island",
    kind: "three",
    prompt:
      "Procedural low-poly island floating in space. Camera slowly orbits. Add subtle fog and particles.",
  },
  {
    label: "FPS maze",
    kind: "three",
    prompt:
      "First-person maze explorer. WASD + mouse look. Procedural walls. Goal marker you must reach.",
  },
  {
    label: "Particle galaxy",
    kind: "three",
    prompt:
      "Interactive particle galaxy with three.js. Mouse moves attractor. Thousands of points with additive blending.",
  },
  {
    label: "Canvas generative art",
    kind: "canvas",
    prompt:
      "Generative 2D art on HTML canvas (no three.js). Flow-field lines that react to mouse. Fullscreen, dark background.",
  },
  {
    label: "P5 sketch",
    kind: "p5",
    prompt:
      "Creative p5.js sketch loaded from https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js — flowing noise terrain with color cycling.",
  },
  {
    label: "WebGPU triangle",
    kind: "webgpu",
    prompt:
      "Minimal WebGPU demo: animated gradient triangle on a canvas. Feature-detect WebGPU and show a friendly fallback message.",
  },
];

export const STARTER_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Playground Demo</title>
  <style>
    body { margin: 0; overflow: hidden; background: #0a0a0f; color: #ddd; font-family: system-ui, sans-serif; }
    canvas { display: block; }
    .hud { position: absolute; top: 12px; left: 12px; font-size: 12px; opacity: 0.7; pointer-events: none; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="hud">three.js • click + drag to orbit • scroll to zoom</div>
  <script src="${THREE_CDN}"></script>
  <script>
    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0f, 20, 120);

    const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 6, 14);

    const hemi = new THREE.HemisphereLight(0x88aaff, 0x222233, 0.8);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(10, 20, 5);
    scene.add(dir);

    const grid = new THREE.GridHelper(40, 40, 0x334455, 0x112233);
    grid.position.y = -0.01;
    scene.add(grid);

    const group = new THREE.Group();
    scene.add(group);

    const mat = new THREE.MeshPhongMaterial({ color: 0x33ff99, shininess: 30 });
    for (let i = 0; i < 12; i++) {
      const geo = new THREE.IcosahedronGeometry(0.6 + Math.random() * 0.4, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (Math.random() - 0.5) * 18,
        1 + Math.random() * 3,
        (Math.random() - 0.5) * 18
      );
      mesh.userData = { speed: 0.4 + Math.random() * 1.2, phase: Math.random() * Math.PI * 2 };
      group.add(mesh);
    }

    const floorMat = new THREE.MeshPhongMaterial({ color: 0x112233 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
    floor.rotation.x = -Math.PI * 0.5;
    scene.add(floor);

    let isDown = false;
    let prevX = 0, prevY = 0;
    let yaw = 0.6, pitch = 0.35, dist = 18;

    function updateCamera() {
      const x = Math.cos(yaw) * Math.cos(pitch) * dist;
      const z = Math.sin(yaw) * Math.cos(pitch) * dist;
      const y = Math.sin(pitch) * dist + 3;
      camera.position.set(x, y, z);
      camera.lookAt(0, 3, 0);
    }
    updateCamera();

    canvas.addEventListener('mousedown', e => { isDown = true; prevX = e.clientX; prevY = e.clientY; });
    window.addEventListener('mouseup', () => { isDown = false; });
    window.addEventListener('mousemove', e => {
      if (!isDown) return;
      const dx = (e.clientX - prevX) * 0.004;
      const dy = (e.clientY - prevY) * 0.004;
      yaw -= dx; pitch = Math.max(-1.3, Math.min(1.3, pitch + dy));
      prevX = e.clientX; prevY = e.clientY;
      updateCamera();
    });
    canvas.addEventListener('wheel', e => {
      dist = Math.max(4, Math.min(60, dist + e.deltaY * 0.03));
      updateCamera();
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let t = 0;
    function animate() {
      requestAnimationFrame(animate);
      t += 0.016;
      group.children.forEach((m, i) => {
        m.rotation.y = t * 0.6 + i;
        m.position.y = 1.5 + Math.sin(t * m.userData.speed + m.userData.phase) * 0.8;
      });
      renderer.render(scene, camera);
    }
    animate();
  </script>
</body>
</html>`;

export interface CodeValidation {
  ok: boolean;
  warnings: string[];
}

export function validateExtractedCode(code: string): CodeValidation {
  const warnings: string[] = [];
  const c = code.trim();
  if (!c) return { ok: false, warnings: ["Empty output"] };

  const lower = c.toLowerCase();
  const hasDoc = lower.includes("<!doctype") || lower.includes("<html");
  const hasScript = lower.includes("<script");
  const hasCloseHtml = lower.includes("</html>");
  const hasThree = /three\.js|webglrenderer/i.test(c);
  const hasCanvas = lower.includes("<canvas");

  if (!hasDoc) warnings.push("Missing <!DOCTYPE> or <html> — wrap may be required");
  if (!hasScript && !hasCanvas) warnings.push("No <script> or <canvas> detected");
  if (hasDoc && !hasCloseHtml) warnings.push("Missing closing </html> — generation may be truncated");
  if (/```/.test(c)) warnings.push("Markdown fences still present — extraction incomplete");

  const ok = hasDoc && hasCloseHtml && (hasScript || hasCanvas || hasThree);
  return { ok, warnings };
}

export function extractCode(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  const s = raw;
  const fence = /```[\t ]*(?:html|htm|javascript|js|typescript|ts|)?[\t ]*\r?\n?([\s\S]*?)\r?\n?```/gi;
  let best = "";
  let match: RegExpExecArray | null;
  while ((match = fence.exec(s)) !== null) {
    const block = match[1].trim();
    if (block.length > best.length) best = block;
  }
  if (best.length > 40) return best;

  const doctypeIdx = s.search(/<!DOCTYPE[\s\S]{0,100}html/i);
  if (doctypeIdx !== -1) {
    let candidate = s.slice(doctypeIdx).trim();
    const lastFence = candidate.lastIndexOf("```");
    if (lastFence > 300) candidate = candidate.slice(0, lastFence).trim();
    const endHtml = candidate.toLowerCase().lastIndexOf("</html>");
    if (endHtml > 200) candidate = candidate.slice(0, endHtml + 7);
    if (candidate.length > 60) return candidate;
  }

  const htmlTagIdx = s.search(/<html[\s>]/i);
  if (htmlTagIdx !== -1) {
    let candidate = s.slice(htmlTagIdx);
    const end = candidate.toLowerCase().indexOf("</html>");
    if (end > 50) candidate = candidate.slice(0, end + 7);
    candidate = candidate.trim();
    if (candidate.length > 60) return candidate;
  }

  if (/WebGLRenderer|three\.js|<canvas|requestAnimationFrame/i.test(s) && s.length > 80) {
    return s.trim();
  }

  return s.trim();
}

export function wrapIfNeeded(code: string): string {
  const c = code.trim();
  if (c.startsWith("<!DOCTYPE") || c.toLowerCase().startsWith("<html")) return c;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>body{margin:0;background:#0a0a0f}canvas{display:block}</style></head>
<body>
<script src="${THREE_CDN}"></script>
${c.includes("<canvas") ? c : `<canvas id="c" style="width:100vw;height:100vh"></canvas><script>${c}</script>`}
</body></html>`;
}

export function looksLikeHtml(code: string): boolean {
  const c = code.toLowerCase();
  return c.includes("<!doctype") || c.includes("<html") || (c.includes("<canvas") && c.includes("<script"));
}

export interface PreviewIssueLine {
  level: "log" | "warn" | "error";
  msg: string;
}

export function buildFixErrorsPrompt(
  consoleLines: PreviewIssueLine[],
  validationWarnings: string[],
  userNote?: string,
): string {
  const errors = consoleLines.filter((l) => l.level === "error");
  const warns = consoleLines.filter((l) => l.level === "warn");

  let p =
    "The live preview hit errors or warnings. Fix the CURRENT CODE so it runs cleanly in the sandboxed iframe.\n";
  p += "Return the FULL corrected HTML document in a single ```html ... ``` block.\n";
  p += "Do not explain at length — prioritize a working fix.\n";
  p += "Use valid JavaScript syntax (no stray commas, no truncated scripts).\n";
  p += `Load three.js only via: <script src="${THREE_CDN}"></script> in <head> — do not paste that tag inside JS strings.\n\n`;

  if (errors.length > 0) {
    p += "RUNTIME ERRORS (captured from preview console):\n";
    for (const e of errors.slice(-10)) p += `- ${e.msg}\n`;
    p += "\n";
  }
  if (warns.length > 0) {
    p += "RUNTIME WARNINGS:\n";
    for (const w of warns.slice(-6)) p += `- ${w.msg}\n`;
    p += "\n";
  }
  if (validationWarnings.length > 0) {
    p += "STATIC CHECKS (before preview):\n";
    for (const w of validationWarnings) p += `- ${w}\n`;
    p += "\n";
  }
  if (errors.length === 0 && warns.length === 0 && validationWarnings.length === 0) {
    p += "The demo does not look like valid HTML or may be incomplete. Repair structure and scripts.\n\n";
  }
  if (userNote?.trim()) p += `Extra context: ${userNote.trim()}\n`;

  return p.trim();
}

export function hasPreviewIssues(
  consoleLines: PreviewIssueLine[],
  validation: CodeValidation | null,
  codeLooksGood: boolean,
): boolean {
  if (consoleLines.some((l) => l.level === "error" || l.level === "warn")) return true;
  if (validation && validation.warnings.length > 0) return true;
  return !codeLooksGood;
}

function trimCodeForPrompt(code: string, maxChars: number): string {
  if (code.length <= maxChars) return code;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 80;
  return `${code.slice(0, head)}\n<!-- … ${code.length - head - tail} chars omitted for context … -->\n${code.slice(-tail)}`;
}

export function estimatePromptChars(
  userText: string,
  previousCode: string,
  history: PlaygroundChatTurn[],
): number {
  return (
    CODEGEN_SYSTEM.length +
    userText.length +
    trimCodeForPrompt(previousCode, PLAYGROUND_MAX_PROMPT_CODE_CHARS).length +
    history.slice(-PLAYGROUND_HISTORY_TURNS_FOR_PROMPT).reduce((n, t) => n + t.content.length, 0)
  );
}

export function buildPromptForModel(
  userText: string,
  previousCode: string,
  history: PlaygroundChatTurn[],
  maxCtxChars?: number,
): string {
  const turns = history.slice(-PLAYGROUND_HISTORY_TURNS_FOR_PROMPT);
  let codeSlice = previousCode.length > 20 ? trimCodeForPrompt(previousCode, PLAYGROUND_MAX_PROMPT_CODE_CHARS) : "";

  if (maxCtxChars && maxCtxChars > 0) {
    let budget = maxCtxChars - CODEGEN_SYSTEM.length - userText.length - 512;
    while (budget < 0 && turns.length > 0) {
      turns.shift();
      budget = maxCtxChars - CODEGEN_SYSTEM.length - userText.length - 512;
    }
    if (codeSlice.length > budget * 0.6) {
      codeSlice = trimCodeForPrompt(codeSlice, Math.max(0, Math.floor(budget * 0.6)));
    }
  }

  let p = `${CODEGEN_SYSTEM}\n\n`;
  if (codeSlice) {
    p += `CURRENT CODE (last known version):\n\`\`\`html\n${codeSlice}\n\`\`\`\n\n`;
  }
  for (const t of turns) {
    if (t.role === "user") p += `User: ${t.content}\n\n`;
    else p += `Assistant: ${t.content.slice(0, PLAYGROUND_ASSISTANT_SLICE)}\n\n`;
  }
  p += `User request: ${userText}\n\nProvide brief notes if useful, then the complete HTML inside a single \`\`\`html ... \`\`\` block.`;
  return p;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildChatMessages(
  userText: string,
  previousCode: string,
  history: PlaygroundChatTurn[],
  maxCtxChars?: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: CODEGEN_SYSTEM }];
  let codeSlice =
    previousCode.length > 20 ? trimCodeForPrompt(previousCode, PLAYGROUND_MAX_PROMPT_CODE_CHARS) : "";

  if (maxCtxChars && maxCtxChars > 0 && codeSlice.length > maxCtxChars * 0.35) {
    codeSlice = trimCodeForPrompt(codeSlice, Math.floor(maxCtxChars * 0.35));
  }
  if (codeSlice) {
    messages.push({
      role: "user",
      content: `CURRENT CODE (last known version):\n\`\`\`html\n${codeSlice}\n\`\`\``,
    });
    messages.push({
      role: "assistant",
      content: "Understood — I will return the full updated HTML document when you request changes.",
    });
  }

  for (const t of history.slice(-PLAYGROUND_HISTORY_TURNS_FOR_PROMPT)) {
    messages.push({
      role: t.role,
      content: t.role === "assistant" ? t.content.slice(0, PLAYGROUND_ASSISTANT_SLICE) : t.content,
    });
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

export function capCodeSize(code: string): string {
  if (code.length <= PLAYGROUND_MAX_CODE_CHARS) return code;
  return code.slice(0, PLAYGROUND_MAX_CODE_CHARS);
}