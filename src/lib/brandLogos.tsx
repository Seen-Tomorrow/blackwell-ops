export const APP_BRAND_LOGO_SIZE = 40;
const VIEW_W = 128;
const VIEW_H = 30;
const READOUT_SIZE = 4.5;
const READOUT_Y = 27.4;

const WORD_FONT = "'JetBrains Mono','Roboto Mono',monospace";

const LOCKUP_BW = `<text x="5" y="19" font-family="${WORD_FONT}" font-size="10" font-weight="700" letter-spacing="0.09em" fill="currentColor">BLACKWELL</text>`;
const LOCKUP_OPS = `<text x="72" y="19" font-family="${WORD_FONT}" font-size="20" font-weight="800" letter-spacing="0.04em" fill="currentColor">OPS</text>`;
const PULSE_TRACK =
  '<rect x="5" y="21" width="118" height="1.2" rx="0.6" fill="currentColor" opacity="0.32"></rect>';
const PULSE_FILL =
  '<rect x="5" y="21" width="104" height="1.2" rx="0.6" fill="currentColor"></rect>';
const PULSE_COUNTDOWN = `<text x="5" y="${READOUT_Y}" font-family="${WORD_FONT}" font-size="${READOUT_SIZE}" font-weight="600" letter-spacing="0.04em" fill="currentColor" opacity="0.58">engine ready in 3,2,1</text>`;
const PULSE_LABEL = `<text x="123" y="${READOUT_Y}" font-family="${WORD_FONT}" font-size="${READOUT_SIZE}" font-weight="600" letter-spacing="0.04em" text-anchor="end" fill="currentColor" opacity="0.58">88%</text>`;

const BRAND_LOGO_INNER = `${LOCKUP_BW}${LOCKUP_OPS}${PULSE_TRACK}${PULSE_FILL}${PULSE_COUNTDOWN}${PULSE_LABEL}`;

export function brandLogoDisplaySize(height = APP_BRAND_LOGO_SIZE): { width: number; height: number } {
  return {
    width: Math.round(height * (VIEW_W / VIEW_H)),
    height,
  };
}

export function brandLogoInnerMarkup(): string {
  return BRAND_LOGO_INNER;
}

export function brandLogoMarkup(height = APP_BRAND_LOGO_SIZE): string {
  const { width } = brandLogoDisplaySize(height);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${VIEW_W} ${VIEW_H}" fill="none" aria-hidden="true">${brandLogoInnerMarkup()}</svg>`;
}

interface BrandLogoIconProps {
  height?: number;
  className?: string;
}

export function BrandLogoIcon({ height = APP_BRAND_LOGO_SIZE, className }: BrandLogoIconProps) {
  const { width } = brandLogoDisplaySize(height);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: brandLogoInnerMarkup() }}
    />
  );
}