import { useEffect } from "react";
import welcomePlaceholder from "../../assets/onboarding/welcome-placeholder.svg";

const WELCOME_DURATION_MS = 3000;

interface WelcomeAnimationProps {
  onComplete: () => void;
}

export default function WelcomeAnimation({ onComplete }: WelcomeAnimationProps) {
  useEffect(() => {
    const timer = window.setTimeout(onComplete, WELCOME_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  return (
    <div className="setup-welcome">
      <img
        src={welcomePlaceholder}
        alt=""
        className="setup-welcome-art opacity-90"
        draggable={false}
      />
    </div>
  );
}