import { APP_BRAND_LOGO_SIZE, BrandLogoIcon } from "../lib/brandLogos";

interface BlackwellBrandMarkProps {
  /** Header chrome vs centered share-card branding */
  variant?: "header" | "share";
  showVersion?: boolean;
}

export default function BlackwellBrandMark({
  variant = "header",
  showVersion = variant === "header",
}: BlackwellBrandMarkProps) {
  const isShare = variant === "share";

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
          v{__TAURI_VERSION__} · {__APP_VERSION__}
        </p>
      )}
    </div>
  );
}