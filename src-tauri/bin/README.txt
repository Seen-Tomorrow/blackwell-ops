Sidecar binaries (bin/)
=======================

Place executables in this folder before dev or release builds.
Files are gitignored (*.exe, *.dll); MinGit at git/ is fully gitignored — copy or stage locally.

  gsudo.exe              — elevated UAC helper (https://github.com/gerardog/gsudo)
  nvidiaInspector.exe    — GPU clock offsets via NVAPI (Orbmu2k)
  7z.exe + 7z.dll        — 7-Zip console archiver for extracting toolchain packs (.7z)
  git/                   — MinGit portable tree (cmd/git.exe + mingw64/ + usr/)

MinGit setup (one-time before dev or release build):
  .\scripts\stage-mingit.ps1
  → extracts to src-tauri/bin/git/

Portable CMake is NOT in bin/ — it ships inside the Full Foundry toolchain pack at
  toolchain/cmake/bin/cmake.exe
Re-pack for GitHub (Majestic menu 11 or):
  .\scripts\build-foundry-toolchain.ps1

On first use, Blackwell Ops stages copies to {app_root}/bin/ next to the running
executable (see `stage_bin` / `stage_7z` / `stage_gsudo` / `stage_git`) so the app stays portable.

See THIRD_PARTY_NOTICES.md for attribution and licenses.