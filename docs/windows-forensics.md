# Windows platform forensics

Long-form detail behind the one-line invariants in `AGENTS.md`. `AGENTS.md` is loaded into
every agent session; this file is read on demand when one of those symptoms actually shows up.
Nothing here is a code map — it is the evidence trail for four Windows-specific failure modes
that cost real sessions to diagnose.

---

## 1. Integrity labels and the "Low stamp"

**Cause confirmed 2026-10-04**, after being *suspected DSH-only* for a while.

The trigger is the **DSH sandbox mode of the session that last touched the folder**, not the
agent's own token. `workspace-write` calls `grantWrite` on Windows, which stamps the workspace
folder **Low** and **leaves the stamp after the session ends**. `danger-full-access` does not
stamp — which is why days of builds with DSH open were fine, and why flipping modes back and
forth appeared to "fix then break" it.

Inheritance is applied **at creation time**. A folder stamped Low makes every PE built
afterwards Low, and switching the sandbox mode back does **not** remove the stamp. Lifting the
root label later does **not** retroactively fix children already stamped, and a rebuild into the
still-labelled tree comes out Low again too.

Filed upstream as [dsh-desktop#1302](https://github.com/anywhere-labs/dsh-desktop/issues/1302)
(2026-10-03). **Answered 2026-10-04: DSH does NOT lift the root label on exit** — that was the
open question, and it is the bug. Switching the workspace's sandbox mode back to full access does
not remove the stamp either.

### Symptom signature A — file writes outside the workspace

Run from the owner's Medium-IL shell, effective IL is `min(parent, file label)` = **Low**, and a
Low process cannot write `%TEMP%`, `C:\`, or the profile. Result: silent `os error 5` in any code
path touching files outside the workspace.

Concretely: ~15 `cargo test` failures that are all `std::env::temp_dir()` (`fs_util`,
`config::merge_tests`, `foundry_toolchain::crt_tests`, `gguf_patch`, `reactor_foundry::git`)
while `tsc` and vitest stay green.

**Not** Bitdefender, **not** an ACL, **not** an MIC policy — a signed `cmd.exe` writes to `%TEMP%`
fine in the very same shell; only the Low-labeled exe is denied. Redirecting `TEMP` into the
workspace also makes the suite green, which is a misleading "fix". A Low process cannot relabel
its own output (`icacls /setintegritylevel` → Access denied).

### Symptom signature B — the WebView2 broker handshake

A DEV launch dying in `tauri::Builder` setup with:

```
Failed to setup app: failed to create webview: WebView2 error:
0x800700AA "The requested resource is in use."
```

The build is fine — the exe links and is stamped at the same second as the panic. A Low PE cannot
complete the broker handshake with the Medium-IL WebView2 runtime, and `OLE_E_INUSE` is a
misleading message for an integrity denial.

Rule out commit exhaustion first (§4 — `handle_alloc_error` also aborts), then check the label.
An **already-Medium** exe still runs, so "it worked an hour ago" is consistent with a folder that
got stamped in between.

### The fix, and what it must not become

Raise the folder back to Medium (`icacls <root> /setintegritylevel Medium`), then build from a
normal shell. Do **not** run `icacls` before every build — that treats the symptom.

To keep it clean, keep this workspace's DSH sandbox on **full access**; the next `workspace-write`
session will stamp it again. Neither of the two workarounds tried while the folder was Low should
ever be committed:

- `TEMP` / `TMP = tmp/rust-temp` in `.cargo/config.toml` (to dodge `LNK1104` on `lnk*.tmp`)
- `debug = false` for `aws-lc-sys` / `ring` (to dodge `D8050` from cl.exe's `/Z7` debug-record writer)

Both are symptom patches on a build that was only broken by the stamp. Verified 2026-10-04: with
the root back at Medium, both reverted, `cargo test` 303, vitest 98, clippy and `tsc` clean. They
are recoverable from `git stash list` → `grok-lowil-workarounds` if a future `workspace-write`
session re-stamps the tree and a rebuild is impossible — but the fix is the label, not the config.

### What is safe to ship

**Shipping is NOT affected** — confirmed 2026-10. The installed REL app has no label ACE at all.
7z / NSIS do not carry SACLs, and extraction into `C:\AI-MASTER\…` (an unlabelled parent) yields
the default Medium. Pack+Ship stays correct.

Only PEs run **in place from `target\`** are Low, which is why DEV builds silently lose
`%TEMP%\blackwell-crash.log` and `-panic.log`. That is the whole reason this matters beyond the
test-suite noise: crash diagnostics vanish, not the product.

### The ACEs are the design, not a defect — while a session is live

On the workspace root during a `workspace-write` session they read as:

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
Everyone:(CI)(DENY)(DC)
S-1-4-*   (a grant)
```

The `diagnose-windows-sandbox-acl` skill names the deny and the `S-1-4-*` grant as *expected, not
conflicts*, and the Low label is what lets the Low-IL sandbox write into the workspace at all.

Never hand-edit them **during** such a session, never `icacls /T` over the tree, never run that
skill elevated or via `runas` — **unconfined does not elevate the token**, and nothing here needs
elevation. Writes outside the workspace are an *expected* denial the skill says to explain, not
fix.

After the session ends the leftover stamp is the bug, not the design: leave a live session's ACEs
alone, clear the orphaned stamp once nothing needs it. The two rules are not in conflict.

---

## 2. ReFS / Dev Drive

Verified 2026-10 on a 1 TB Dev Drive: `icacls <dir> /setintegritylevel Low` on ReFS persists and
reads back exactly as on NTFS, so the stamp workflow in §1 is unaffected by *where* the tree lives.
Three traps found while proving it:

- **A freshly formatted Dev Drive grants `Authenticated Users:(M)` and no per-user ACE** — unlike a
  profile path, which inherits an explicit `<you>:FullControl`. `Modify` lacks
  `WRITE_DAC`/`WRITE_OWNER`, so `setintegritylevel` fails **Access is denied** from a normal shell,
  which reads like a ReFS limitation and is not one. One-time fix:
  `icacls <dev-drive-root> /grant "${env:USERNAME}:(OI)(CI)F" /T`. After that the Dev Drive behaves
  exactly like a `C:` profile path, unelevated.
- **`"$env:USERNAME:(OI)(CI)F"` silently drops the username** — PowerShell swallows the trailing
  colon as part of the variable name, so icacls receives a bare `(OI)(CI)F` and reports
  `Invalid parameter "(OI)(CI)F"`. Always brace it: `${env:USERNAME}`.
- **`icacls /setintegritylevel` writes a NON-inheritable label** — the ACE reads
  `Mandatory Label\Low Mandatory Level:(NW)` with no `(OI)(CI)`, on NTFS and ReFS alike, and a child
  directory gets nothing. The `(OI)(CI)(NW)` seen on a stamped workspace root exists because DSH's
  `grantWrite` sets those flags deliberately. **Inheritance is a property of who stamps, not of the
  filesystem** — never infer a filesystem limitation from the missing flags.

---

## 3. `0xC0000409` after reboot — Instant underflow

Not WebView. Windows `Instant` is boot-relative. `Instant::now() - Duration::from_secs(3600)` — or
any window longer than the current uptime — **panics** with `overflow when subtracting duration
from instant`. REL builds use `panic = "abort"`, so the process dies right after the frontend ping:
canvas blinks, exit `0xC0000409`.

Hit path: the GitHub REST gateway hourly budget in `github_releases.rs` (`budget_remaining`),
reached from REL `get_startup_updates` (DEV skips automatic startup checks, which is why this only
ever appeared in REL).

Fix pattern: `now.saturating_duration_since(t) < window` or `checked_sub` — never a bare
`Instant - Duration`. Never reintroduce cutoff-via-subtraction in rate budgets, TTLs, or caches.

Diagnose via `%TEMP%\blackwell-panic.log` (not only `blackwell-crash.log`).

The repo enforces this one mechanically: `src/lib/repoInvariants.test.ts` fails if any `.rs` file
outside `#[cfg(test)]` subtracts from an `Instant`.

---

## 4. `0xC0000409` is not always the Instant bug — commit exhaustion

`handle_alloc_error` aborts, and on Windows an abort surfaces as `0xC0000409` — **identical to §3**.
Read app stdout first: `memory allocation of N bytes failed` means the **system commit limit** ran
out. Not a panic, not the GPU, not heap corruption.

Commit is charged by *promise*, not by use, so this fires with 134 GiB of physical RAM free.
Task Manager's Memory column looks healthy; **Details → "Commit size"** is the one that tells the
truth.

Under WDDM a `cudaMalloc` is backed by a page-file-backed section, so **VRAM allocations charge
host commit as well** — a big-VRAM engine inflates commit twice.

Observed 2026-10-02: two llama.cpp-family engines on the same cards committed 291 of a 311 GiB
limit. The DEV build died first because a debug build commits more address space than REL, so
**"DEV crashes, REL is fine" is not evidence of a DEV bug**.

`CreateProcess` and COM DLL loads need commit too — that is why nvidia-smi "cannot launch" and
WebView2 "Class not registered" appear together, and why the window goes transparent.

No TDR, no WER, no panic: nothing crashed, an allocation was denied. Diagnose with
`\Memory\Committed Bytes` vs `\Memory\Commit Limit`, never free RAM.
