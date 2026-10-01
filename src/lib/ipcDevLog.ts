/**
 * DEV-only IPC failure amplifier.
 *
 * Renaming a `#[tauri::command]` parameter in Rust without updating the matching
 * `invoke()` call makes Tauri reject the call with an "invalid args" error naming
 * the offending key. That message is the whole diagnosis — and it is normally
 * destroyed before it reaches the console, because call sites flatten the error:
 * `typeof e === "string" ? e : "unknown error"` renders a rejected `Error` as
 * literally "REPRIORITIZE FAILED: unknown error".
 *
 * `@tauri-apps/api/core`'s `invoke()` is a one-line delegation to
 * `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`, so wrapping that single
 * entry point covers every call site — including ones added later — with no churn
 * across the ~130 `invoke()` calls.
 *
 * The caller gates on `__BUILD_MODE__ === "dev"` (see `main.tsx`) rather than this
 * module: that global is a Vite `define` from `vite.config.ts` and is absent under
 * `vitest.config.ts`, so referencing it here would make the module unimportable.
 */

type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>,
  options?: unknown,
) => Promise<unknown>;

let installed = false;

export function installIpcFailureLog(): void {
  if (installed) return;
  if (typeof window !== "object" || window === null || !("__TAURI_INTERNALS__" in window)) return;

  // Narrow step by step: a missing or reshaped global leaves the app untouched
  // rather than throwing during startup.
  const internals: unknown = window.__TAURI_INTERNALS__;
  if (typeof internals !== "object" || internals === null || !("invoke" in internals)) return;
  if (typeof internals.invoke !== "function") return;

  // Tauri injects this global untyped; the checks above prove `invoke` is a
  // function and its signature is fixed by @tauri-apps/api/core's delegation.
  // Replacing it is the only interception point that avoids editing ~130 sites.
  const target = internals as { invoke: TauriInvoke };
  installed = true;

  const original = target.invoke;
  target.invoke = (cmd, args, options) =>
    original(cmd, args, options).catch((err: unknown) => {
      const sent = args && Object.keys(args).length ? Object.keys(args).join(", ") : "(none)";
      console.error(`[IPC] "${cmd}" rejected — sent args: [${sent}] — reason: ${String(err)}`);
      throw err;
    });
}
