import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { APP_BRAND_LOGO_SIZE, BrandLogoIcon } from "../lib/brandLogos";

interface BlackwellBrandMarkProps {
  /** Header chrome vs centered share-card branding */
  variant?: "header" | "share";
  showVersion?: boolean;
  /**
   * Runtime PE/package version (same as updater). Prefer over Vite bake-time
   * `__TAURI_VERSION__` so header never lies ahead of the installed binary.
   */
  packageVersion?: string | null;
}

export default function BlackwellBrandMark({
  variant = "header",
  showVersion = variant === "header",
  packageVersion = null,
}: BlackwellBrandMarkProps) {
  const isShare = variant === "share";
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(
    packageVersion && packageVersion.trim() ? packageVersion.trim() : null,
  );

  useEffect(() => {
    if (packageVersion && packageVersion.trim()) {
      setRuntimeVersion(packageVersion.trim());
      return;
    }
    let cancelled = false;
    invoke<string>("get_app_package_version")
      .then((v) => {
        if (!cancelled && v?.trim()) setRuntimeVersion(v.trim());
      })
      .catch(() => {
        /* non-Tauri / offline — fall back to compile-time define */
      });
    return () => {
      cancelled = true;
    };
  }, [packageVersion]);

  // Prefer runtime package_info; Vite define is last resort only.
  const semver = runtimeVersion || __TAURI_VERSION__;

  return (
    <div
      className={`${isShare ? "fusion-share-brand-mark flex items-center gap-2" : "app-header-brand"}`}
    >
      <BrandLogoIcon
        height={APP_BRAND_LOGO_SIZE}
        className="flex-shrink-0 app-header-logo"
      />
      {showVersion && (
        <p className="app-header-version font-mono tracking-wide">
          v{semver} · {__APP_VERSION__}
        </p>
      )}
    </div>
  );
}
