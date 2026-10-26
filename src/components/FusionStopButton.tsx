/**
 * Amber, double-size STOP for the fusion face.
 *
 * Two destructive actions share this face: abort the in-flight benchmark, and
 * abort a model that is still loading. The engine STOP stays the small red ops
 * chip in the identity rail — these are the "long action" kills, deliberately
 * bigger and amber so they read as a different thing.
 */

interface FusionStopButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export default function FusionStopButton({
  label,
  onClick,
  disabled = false,
  title,
  className,
}: FusionStopButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={className ? `fusion-stop-btn ${className}` : "fusion-stop-btn"}
    >
      {label}
    </button>
  );
}
