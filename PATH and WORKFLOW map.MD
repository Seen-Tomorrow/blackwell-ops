Here’s the path map in plain terms — one mental model, three copy flows, and where you actually edit things.

The one rule

App root = folder where blackwell-ops.exe lives.

• DEV: src-tauri/target/debug/
• REL: wherever the user installed it

Everything the running app cares about is relative to that folder.

───

Folder roles (what lives where)

<app_root>/
├── runtime/                          ← bundled engines + factory configs (read by app)
│   ├── ggml-master/
│   │   ├── config/
│   │   │   └── ggml-master-default-config.json   ← FACTORY (you edit in repo)
│   │   ├── vanguard/llama-server.exe             ← binaries
│   │   ├── stable/
│   │   └── fresh/
│   └── ik/
│       ├── config/ik-default-config.json
│       └── vanguard/...
│
├── config/                           ← per-user overrides (created at runtime)
│   ├── ggml-master-user-config.json
│   └── app_config.json               ← legacy; gpu_slots is NOT the slot cap anymore
│
└── foundry/                          ← build workspace (not what you ship)
    ├── artifacts/<provider>/<env>/Release/   ← sacred foundry output
    └── engines/<provider>/work/                ← disposable, nuked after builds

In the repo, the source of truth you edit before shipping is:

src-tauri/runtime/<provider>/config/<provider>-default-config.json

That’s where spawn_profile.max_engine_slots, params, templateVersion, cmake flags, etc. live.

───

What copies where (and why)

1. DEV startup — full runtime copy (predev)

src-tauri/runtime/*  →  target/debug/runtime/

When: every npm run dev (runs predev first)
Why: the debug exe lives in target/debug/, so it needs a runtime/ folder next to it.
What: everything — configs and binaries.

2. DEV app start — config-only refresh (new)

src-tauri/runtime/<provider>/config/*.json  →  target/debug/runtime/<provider>/config/

When: each debug app launch (sync_dev_runtime_factory_configs in config.rs)
Why: so you can tweak max_engine_slots or params without re-running npm run dev and without wiping mirrored binaries in target/debug/runtime/.
What: JSON configs only — binaries untouched.

3. Release prep — mirror foundry binaries (prerelease)

target/debug/foundry/artifacts/<provider>/<env>/Release/*
  →  src-tauri/runtime/<provider>/<env>/

When: npm run release (runs prerelease → mirror-artifacts.ps1)
Why: foundry builds land in foundry/artifacts/ (disposable workspace). You copy fresh exes/dlls into src-tauri/runtime/ so the installer ships them.
What: binaries only — config/ is never touched by this script.

4. Release install — bundle to end user

Intended flow: src-tauri/runtime/ gets bundled into the installer and ends up as <install_dir>/runtime/ beside the exe. On first REL launch, if runtime/ is missing, the app copies from Tauri resources into app_root/runtime/.

Note: tauri.conf.json currently has "resources": []. For release users to get runtime/ automatically, that should include runtime/**/* (as described in Agents.md). Right now the folder you maintain for shipping is still src-tauri/runtime/ — make sure it ends up next to the release exe one way or another.

───

Where to edit so users get your changes

┌─────────────────────────────────────────────────────┬────────────────────────────────────────────────┬───────────────────────┐
│ You want to change…                                 │ Edit here                                      │ Users get it when…    │
├─────────────────────────────────────────────────────┼────────────────────────────────────────────────┼───────────────────────┤
│ Default params, flags, spawn_profile, max_engine_   │ src-tauri/runtime/<provider>/config/<provider> │ Bundled in runtime/   │
│ slots, templateVersion                              │ -default-config.json                           │ on install            │
├─────────────────────────────────────────────────────┼────────────────────────────────────────────────┼───────────────────────┤
│ Fresh llama-server.exe after a foundry build        │ Run mirror → updates src-tauri/runtime/<       │ Same — bundled with   │
│                                                     │ provider>/<env>/                               │ release               │
├─────────────────────────────────────────────────────┼────────────────────────────────────────────────┼───────────────────────┤
│ User’s personal toggles / reorders                  │ Don’t edit for shipping — app writes config/   │ Per-machine only      │
│                                                     │ <id>-user-config.json                          │                       │
└─────────────────────────────────────────────────────┴────────────────────────────────────────────────┴───────────────────────┘

Do not edit target/debug/runtime/ for shipping — that’s a dev copy.
Do not edit config/*-user-config.json in the repo to set factory defaults.

───

Your workflows

Change factory config (e.g. max_engine_slots: 128):
1. Edit src-tauri/runtime/ggml-master/config/ggml-master-default-config.json
2. Restart the dev app (config sync runs on start), or run npm run dev for a full copy
3. For release: npm run release after mirror if binaries changed too

Ship new binaries from foundry:
1. Build in Foundry → artifacts land in foundry/artifacts/...
2. npm run release (mirror copies exes into src-tauri/runtime/, then builds installer)

───

Quick diagram

flowchart LR
  subgraph repo ["Repo (you edit)"]
    SRC["src-tauri/runtime/"]
    CFG[".../config/*.json"]
    BIN[".../vanguard/*.exe"]
  end

  subgraph foundry ["Foundry build"]
    ART["foundry/artifacts/.../Release/"]
  end

  subgraph dev ["DEV app"]
    DBG["target/debug/runtime/"]
  end

  subgraph user ["End user"]
    INST["install_dir/runtime/"]
    USER["config/*-user-config.json"]
  end

  CFG --> SRC
  ART -->|"mirror-artifacts.ps1"| BIN
  SRC -->|"predev + config sync"| DBG
  SRC -->|"tauri build / bundle"| INST
  INST -->|"merge on load"| USER

───

Slot cap reminder

max_engine_slots lives in each provider’s factory JSON under spawn_profile, not in app_config.json’s gpu_slots. After editing, restart the app and look for logs like max_engine_slots=128 and Initializing EngineStack with 128 engine slot(s).

If you want, I can also verify your target/debug/runtime/ggml-master/config/ file matches the repo copy right now.