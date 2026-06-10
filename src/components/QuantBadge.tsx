import type { GgufFile } from '@/lib/types';

interface QuantBadgeProps {
  type: string;
  sizeBytes?: number;
  isActive?: boolean;
  onClick?: () => void;
}

function displayQuantLabel(type: string): string {
  const trimmed = type.replace(/\.gguf$/i, '').trim();
  if (!trimmed) return 'GGUF';
  // Already a parsed quant from the backend (Q4_K_M, IQ2_XS, …)
  if (/^(Q\d|IQ\d|FP\d|BF16|F16|MXFP|NVFP)/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const parts = trimmed.split('-');
  return parts.length > 1 ? parts.slice(-2).join('-') : trimmed;
}

export default function QuantBadge({ type, sizeBytes, isActive = false, onClick }: QuantBadgeProps) {
  const name = displayQuantLabel(type);

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