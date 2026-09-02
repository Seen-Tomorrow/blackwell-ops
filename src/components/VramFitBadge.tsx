interface VramFitBadgeProps {
  sizeBytes: number;
  vramGb: number;
}

export default function VramFitBadge({ sizeBytes, vramGb }: VramFitBadgeProps) {
  const sizeGb = sizeBytes / (1024 * 1024 * 1024);
  const fits = sizeGb + 2 <= vramGb;
  const tight = sizeGb + 2 <= vramGb * 1.3;

  if (!vramGb || sizeBytes === 0) return null;

  const state = fits ? 'fit--ok' : tight ? 'fit--tight' : 'fit--no';
  const label = fits ? 'FITS' : tight ? 'TIGHT' : 'OVER';

  return (
    <span className="flex items-center gap-1 flex-shrink-0">
      <span className={`fit-dot w-2 h-2 rounded-full ${state}`} />
      <span className={`fit-label type-tiny font-mono tracking-wider ${state}`}>{label}</span>
    </span>
  );
}