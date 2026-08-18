# GitHub firewall rules for DEV

Ops note for local development. Goal: stop unauthenticated GitHub API **403 / rate-limit** burn from frequent DEV restarts, without breaking Foundry engine builds or REL updates.

Binary-source / Foundry ACTIVE simplify work does **not** change GitHub traffic. This is orthogonal.

---

## Principle

| Build | GitHub |
|---|---|
| **DEV** (`target\debug\blackwell-ops.exe`) | Restrict **API**; keep **git** if you Foundry-build |
| **REL** (`Blackwell OPS portable\blackwell-ops.exe`) | Full allow (updates, packs, normal product) |

Do it by **process path** (or net profile tied to that exe), not “block GitHub for the whole PC.”

---

## Recommended DEV rules

### Deny (DEV only)

| Host | Why |
|---|---|
| `api.github.com` | REST releases / search / discussions — main **60 req/h anon** budget; source of most **403**s |

Optional deny if you never use these from DEV:

| Host / path | Why |
|---|---|
| `api.github.com` only is enough for most cases | — |

### Allow (DEV — needed for engine builds)

| Host | Why |
|---|---|
| `github.com` | Foundry **git clone / pull** of llama.cpp (and similar) |
| `*.githubusercontent.com` / release CDN | Optional: raw file / release asset downloads (toolchain, ninja, pi zip) if you install those from DEV |

### Allow (REL always)

| Process | Hosts |
|---|---|
| `...\Blackwell OPS portable\blackwell-ops.exe` (and helpers it spawns) | `api.github.com`, `github.com`, GitHub CDNs |

---

## What DEV still does on GitHub (code map)

| Path | When | Host | DEV today |
|---|---|---|---|
| Startup update check | App launch | `api.github.com` | **Skipped** (`get_startup_updates` + `#[cfg(debug_assertions)]`) |
| Updates page / header refresh | Manual | `api.github.com` | Live if user clicks |
| Plugin catalog force refresh | Updates | `api.github.com` | Live |
| Intel feed | EXTRAS | `api.github.com` (heavy) | Live — easy rate-limit fuel |
| Foundry clone/pull | Engine build | **`github.com` git** | Required to build |
| Toolchain / ninja / pi packs | Install those | releases / CDN | Only when installing |
| HF catalog updates | Catalog | **huggingface.co** | Not GitHub |

`BINARY_UPDATES_ENABLED` stays `true`; only **auto startup** is DEV-gated. Manual refresh + intel still call the API unless FW or code stops them.

---

## What breaks if you over-block

| Block | Effect |
|---|---|
| **`api.github.com` only (DEV exe)** | Updates/intel fail soft or empty. **Foundry build OK.** REL OK if allowed. |
| **All `github.com` for DEV** | **Foundry git clone/pull fails** — cannot build engines. |
| **Whole machine → GitHub** | REL updates/packs die too unless carved out by path. |

---

## Suggested Windows / FW shape

Example intent (implement in your firewall product of choice):

```
# DEV app binary
DENY  process = ...\src-tauri\target\debug\blackwell-ops.exe
      remote  = api.github.com:443

ALLOW process = ...\src-tauri\target\debug\blackwell-ops.exe
      remote  = github.com:443
      # git + optional HTTPS clone

ALLOW process = ...\src-tauri\target\debug\blackwell-ops.exe
      remote  = *.githubusercontent.com:443
      # optional release assets

# REL product
ALLOW process = ...\Blackwell OPS portable\blackwell-ops.exe
      remote  = api.github.com, github.com, *.githubusercontent.com :443
```

Notes:

- Cargo/`git.exe` used by Foundry may be a **child** or separate process — if clone fails after denying only the app exe, allow `git.exe` → `github.com` when run from the foundry/work tree, or allow the DEV machine user for `github.com` but still deny `api.github.com` for the app.
- NSIS/portable path can contain spaces: match on path substring `Blackwell OPS portable` vs `target\debug`.

### Simplewall (WFP) shape

Simplewall matches **process + direction + protocol + remote IP/range + port** — no hostname/SNI matching (rule model is IP/port only; the "host" in its log is reverse-DNS display). The host split (`api.github.com` deny vs `github.com` allow for the same exe) is **not expressible**, and GitHub hostnames share overlapping anycast IP pools, so IP-based separation is unreliable too.

Practical equivalent (achieves the doc's intent):

| Entry (process) | State | Notes |
|---|---|---|
| `...\src-tauri\target\debug\blackwell-ops.exe` | **Block outbound** | **Loopback = Allow** (engine `:9090+`, Vite `:1420`, MCP bridge are all `127.0.0.1`). Kills the app's `api.github.com` + CDN + HF traffic. |
| `git.exe` / `cargo.exe` / `cmake.exe` / `ninja.exe` | Allow | Foundry spawns these as **separate processes** (not the app's sockets) — builds keep working. |
| `...\Blackwell OPS portable\blackwell-ops.exe` | Allow | REL updates/packs untouched. |

Cost vs the ideal: in-app toolchain/ninja/pi/CDN downloads and HF catalog from DEV die (this doc marks them "only when installing") → flip the rule, or use a Simplewall profile for one-click lift, or `GITHUB_TOKEN` for API work.

Footguns:

- **Loopback column on the DEV exe row must stay Allow** — blocking it kills engine control/fusion/MCP, not just GitHub.
- Simplewall prompts on first sight of unknown programs (default) → explicitly Allow the build tools above to avoid prompt noise mid-Foundry-build.
- Don't rely on child-process inheritance for git/cargo — give them their own Allow entries (REL Foundry needs them too).
- Profiles: save a "DEV" profile (rules above) + a "Normal" profile (no blocks) for one-click lift when installing toolchains from DEV.

---

## Day-of-build checklist

1. FW: DEV → deny `api.github.com`; allow `github.com` (git).
2. Foundry build STABLE/FRONTIER as usual.
3. If clone/pull fails: temporarily allow git path or check that `git.exe` is not blocked.
4. REL: leave GitHub open; no need to touch FW for portable app updates.
5. If you need Updates/intel in DEV once: temporarily allow `api.github.com` or use a `GITHUB_TOKEN` (higher limits) instead of opening the floodgates permanently.

---

## vs more code changes

| Approach | Pros | Cons |
|---|---|---|
| **FW API deny for DEV** | Immediate, no rebuild, stops 403 | Manual Updates/intel dead in DEV |
| DEV code kill-switch (intel + updates net) | Precise UX | Needs ship + maintenance |
| `GITHUB_TOKEN` on DEV | API works with higher quota | Secret hygiene |

Recommended default: **API deny for DEV exe + git allow**. Add code kill-switches later only if FW is too coarse.

---

## Unrelated (do not confuse)

- **Binary source preference / Foundry ACTIVE** — local disk + config only; no GitHub.
- **HF model update checks** — Hugging Face, not this FW doc.
- **REL** must keep GitHub for app/engine pack updates when you want that product path live.
