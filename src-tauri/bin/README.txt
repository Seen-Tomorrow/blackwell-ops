Sidecar binaries (bin/)
=======================

Place executables in this folder before dev or release builds.
Files are gitignored (*.exe); copy your licensed copies here locally.

  gsudo.exe           — elevated UAC helper (https://github.com/gerardog/gsudo)
  nvidiaInspector.exe — GPU clock offsets via NVAPI (Orbmu2k)

On first use, Blackwell Ops stages copies to {app_root}/bin/ next to the running
executable so the app stays portable when the folder is moved.

See THIRD_PARTY_NOTICES.md for attribution.