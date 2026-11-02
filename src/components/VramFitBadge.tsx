interface VramFitBadgeProps {
  sizeBytes: number;
  /** Selected VRAM tier in GB. 0 = no tier selected → render nothing. */
  vramGb: number;
}

/**
 * Text-only fit verdict. It used to be a filled dot + a solid block, which read as
 * an empty red rectangle at 9px and competed with the role badge for the same slot.
 * Silence when no tier is selected is deliberate: assuming 24 GB marked every row
 * of a 4 TB repo "OVER" and taught users to ignore the column entirely.
 */
export default function VramFitBadge({ sizeBytes, vramGb }: VramFitBadgeProps) {
  if (!vramGb || sizeBytes === 0) return null;

  const sizeGb = sizeBytes / (1024 * 1024 * 1024);
  const fits = sizeGb + 2 <= vramGb;
  const tight = !fits && sizeGb + 2 <= vramGb * 1.3;
  const state = fits ? 'hub-fit--ok' : tight ? 'hub-fit--tight' : 'hub-fit--over';
  const label = fits ? 'FITS' : tight ? 'TIGHT' : 'OVER';

  return (
    <span className={`hub-fit type-tiny font-mono tracking-wider ${state}`} title={`${vramGb} GB VRAM budget`}>
      {label}
    </span>
  );
}
