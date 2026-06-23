interface DisplayChromeHintsProps {
  policyReason?: string;
  tensorSplitWarn?: boolean;
}

/** Pre-launch policy hints — pinned to the VRAM display bezel top edge. */
export default function DisplayChromeHints({
  policyReason,
  tensorSplitWarn = false,
}: DisplayChromeHintsProps) {
  const showPolicyHint = Boolean(policyReason);
  const showTensorHint = tensorSplitWarn;
  if (!showPolicyHint && !showTensorHint) return null;

  return (
    <div className="display-chrome-hints" aria-hidden={false}>
      {showPolicyHint && (
        <p className="display-chrome-hints__hint display-chrome-hints__hint--left" role="status">
          {policyReason}
        </p>
      )}
      {showTensorHint && (
        <p className="display-chrome-hints__hint display-chrome-hints__hint--right" role="status">
          Tensor split will disable memory FIT logic, that's expected.
        </p>
      )}
    </div>
  );
}