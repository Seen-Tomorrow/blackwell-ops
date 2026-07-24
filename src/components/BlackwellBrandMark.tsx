import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { APP_BRAND_LOGO_SIZE, BrandLogoIcon } from "../lib/brandLogos";

interface BlackwellBrandMarkProps {
  /**
   * header — logo only in app chrome (version lives in footer).
   * share — logo + optional version on share cards.
   * footer — compact version text for status bar (after PLATFORM).
   */
  variant?: "header" | "share" | "footer";
  showVersion?: boolean;
  /**
   * Runtime PE/package version (same as updater). Prefer over Vite bake-time
   * `__TAURI_VERSION__` so UI never lies ahead of the installed binary.
   */
  packageVersion?: string | null;
}

export default function BlackwellBrandMark({
  variant = "header",
  showVersion = variant === "share" || variant === "footer",
  packageVersion = null,
}: BlackwellBrandMarkProps) {
  const isShare = variant === "share";
  const isFooter = variant === "footer";
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
  const versionText = `v${semver} · ${__APP_VERSION__}`;

  if (isFooter) {
    return (
      <span
        className="app-footer-version font-mono tracking-wide"
        title={`Blackwell Ops ${versionText}`}
      >
        {versionText}
      </span>
    );
  }

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
          {versionText}
        </p>
      )}
    </div>
  );
}
