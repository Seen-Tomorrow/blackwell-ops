Sidecar binaries (bin/)
=======================

Place executables in this folder before dev or release builds.
Files are gitignored (*.exe, *.dll); copy your licensed copies here locally.

  gsudo.exe           — elevated UAC helper (https://github.com/gerardog/gsudo)
  nvidiaInspector.exe — GPU clock offsets via NVAPI (Orbmu2k)
  7z.exe + 7z.dll     — 7-Zip console archiver for extracting toolchain packs (.7z)

On first use, Blackwell Ops stages copies to {app_root}/bin/ next to the running
executable (see `stage_bin` / `stage_7z` / `stage_gsudo`) so the app stays portable.

See THIRD_PARTY_NOTICES.md for attribution and licenses.