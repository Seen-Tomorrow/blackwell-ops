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