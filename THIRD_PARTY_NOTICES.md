# Third-party notices

Blackwell Ops bundles or invokes the following third-party software. This file satisfies attribution for redistribution on GitHub and in release installers.

## Nvidia Inspector

- **Author:** [Orbmu2k](https://github.com/Orbmu2k) (Michael Möller)
- **Component:** `nvidiaInspector.exe` (CLI overclocking via NVAPI)
- **Use in Blackwell Ops:** Hidden command-line invocation from **Telemetry → GPU OVERCLOCK** to apply GPU core and memory clock offsets. Power limits are set separately via `nvidia-smi` (NVIDIA driver tooling).
- **Status:** Original project discontinued; binary bundled for convenience under `src-tauri/bin/`.
- **Requirements:** .NET Framework 2.0 or newer (included with modern Windows).
- **Note:** Nvidia Inspector is not maintained in the Orbmu2k GitHub repository. Obtain updates or alternate builds at your own discretion. Blackwell Ops does not modify the executable.

If you are packaging a release, ensure `src-tauri/bin/nvidiaInspector.exe` is present before `tauri build` (the file is gitignored by default due to repository size policy).

## gsudo

- **Author:** [gerardog](https://github.com/gerardog) (Gerardo Grignoli)
- **Component:** `gsudo.exe` (elevated command execution / UAC helper)
- **Use in Blackwell Ops:** Invokes `nvidia-smi` and Nvidia Inspector with administrator rights from a non-elevated app process. One UAC prompt per apply/reset; stdout/stderr and exit codes return to Rust (no fragile cmd batch logs).
- **License:** MIT
- **Bundle:** `src-tauri/bin/gsudo.exe` (gitignored `*.exe` — see `bin/README.txt` before release builds)

## NVIDIA Management Library (`nvidia-smi`)

- **Vendor:** NVIDIA Corporation
- **Use:** GPU telemetry, power limit (`-pl`), and related queries. Requires an installed NVIDIA display driver.

## 7-Zip

- **Author:** Igor Pavlov
- **Component:** `7z.exe` + `7z.dll` (LZMA / 7z archiver, console version)
- **License:** GNU Lesser General Public License (LGPL) version 2.1 (with some BSD-style code for LZMA SDK; see 7-Zip license for full details)
- **Use in Blackwell Ops:** Extraction of the portable toolchain packs (`.7z` archives containing CUDA runtimes and/or full VS + SDK toolchains) during one-click install via **Config → Foundry Toolchain**. Bundled to avoid requiring users to have 7-Zip installed on their system.
- **Bundle:** `src-tauri/bin/7z.exe` and `7z.dll` (gitignored `*.exe`/ `*.dll` — see `bin/README.txt` before release builds). Staged to `{app_root}/bin/` on first use, consistent with `gsudo.exe`.

## Git for Windows (MinGit)

- **Project:** [git-for-windows/git](https://github.com/git-for-windows/git)
- **Component:** MinGit portable distribution (`cmd/git.exe`, `mingw64/`, `usr/`)
- **License:** GNU General Public License version 2 (see upstream `COPYING`)
- **Use in Blackwell Ops:** Foundry clone/pull/submodule and PR patch apply — no system Git install required.
- **Bundle:** `src-tauri/bin/git/` (gitignored tree — run `scripts/stage-mingit.ps1` before release builds). Staged to `{app_root}/bin/git/` on app launch.

## CMake (Kitware)

- **Vendor:** Kitware, Inc.
- **Component:** CMake console binaries + `share/cmake-*` modules
- **License:** BSD 3-Clause (see upstream `Copyright.txt`)
- **Use in Blackwell Ops:** Foundry `cmake configure` / `cmake --build` — invoked by absolute path, never from host PATH.
- **Bundle:** Inside the Full Foundry toolchain `.7z` at `toolchain/cmake/` (populated via `scripts/populate-foundry-toolchain.ps1`, trimmed by `scripts/slim-foundry-toolchain.ps1`). Not shipped in the Runtime-only pack.
