interface VramFitBadgeProps {
  sizeBytes: number;
  vramGb: number;
}

export default function VramFitBadge({ sizeBytes, vramGb }: VramFitBadgeProps) {
  const sizeGb = sizeBytes / (1024 * 1024 * 1024);
  const fits = sizeGb + 2 <= vramGb;
  const tight = sizeGb + 2 <= vramGb * 1.3;

  if (!vramGb || sizeBytes === 0) return null;

  const dotColor = fits ? 'bg-nv-green' : tight ? 'bg-yellow-500' : 'bg-red-500';
  const textColor = fits ? 'text-nv-green/60' : tight ? 'text-yellow-500/60' : 'text-red-400/60';
  const label = fits ? 'FITS' : tight ? 'TIGHT' : 'OVER';

  return (
    <span className="flex items-center gap-1 flex-shrink-0">
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      <span className={`text-[8px] font-mono tracking-wider ${textColor}`}>{label}</span>
    </span>
  );
}