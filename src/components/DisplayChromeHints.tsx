interface DisplayChromeHintsProps {
  policyReason?: string;
}

/** Pre-launch policy hints — pinned to the VRAM display bezel top edge. */
export default function DisplayChromeHints({
  policyReason,
}: DisplayChromeHintsProps) {
  if (!policyReason) return null;

  return (
    <div className="display-chrome-hints" aria-hidden={false}>
      {/* Far right of top bezel — after Device; left is ASSISTED/FULL AUTO */}
      <p className="display-chrome-hints__hint display-chrome-hints__hint--right" role="status">
        {policyReason}
      </p>
    </div>
  );
}
