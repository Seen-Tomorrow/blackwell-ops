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
      className={`flex items-center gap-2 ${isShare ? "fusion-share-brand-mark" : ""}`}
    >
      <BrandLogoIcon
        height={APP_BRAND_LOGO_SIZE}
        className="flex-shrink-0 app-header-logo"
      />
      {showVersion && (
        <div>
          <p className="app-header-subtitle text-[8px] font-mono tracking-wider">
            v{__TAURI_VERSION__} · BUILD {__APP_VERSION__}
          </p>
        </div>
      )}
    </div>
  );
}