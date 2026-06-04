import type { GgufFile } from '@/lib/types';

interface QuantBadgeProps {
  type: string;
  sizeBytes?: number;
  isActive?: boolean;
  onClick?: () => void;
}

export default function QuantBadge({ type, sizeBytes, isActive = false, onClick }: QuantBadgeProps) {
  const base = type.replace('.gguf', '');
  const parts = base.split('-');
  const name = parts.length > 1 ? parts.slice(-2).join('-') : base;

  return (
    <span
      onClick={onClick}
      className={`text-[8px] font-mono px-1.5 py-0.5 rounded-sm flex-shrink-0 ${
        isActive
          ? 'value-chip-active'
          : 'value-chip'
      } ${onClick ? 'cursor-pointer' : ''}`}
    >
      {name}
      {sizeBytes && (
        <span className="ml-1 text-stealth-muted/40">{formatSize(sizeBytes)}</span>
      )}
    </span>
  );
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}