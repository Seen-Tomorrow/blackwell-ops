interface CudaMarkProps {
  className?: string;
}

/**
 * Monochrome CUDA mark for the RUNTIME MODE switch.
 *
 * A chip outline with the "C" core: the app's industrial language rather than a
 * raster brand asset, so it inherits `currentColor` and themes with the switch
 * (muted at rest, amber + glow when the option is armed).
 */
export default function CudaMark({ className }: CudaMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="4.6"
        y="4.6"
        width="14.8"
        height="14.8"
        rx="3.2"
        stroke="currentColor"
        strokeWidth="1.25"
        opacity="0.85"
      />
      <path
        d="M9.1 2.7v1.9M14.9 2.7v1.9M9.1 19.4v1.9M14.9 19.4v1.9M2.7 9.1h1.9M2.7 14.9h1.9M19.4 9.1h1.9M19.4 14.9h1.9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M14.8 9.2a4.2 4.2 0 1 0 0 5.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12.1" cy="12" r="1.05" fill="currentColor" />
    </svg>
  );
}
