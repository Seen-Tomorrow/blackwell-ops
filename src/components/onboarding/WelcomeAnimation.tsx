import { useEffect } from "react";
import onboardingIntro from "../../assets/onboarding/onboarding-intro.webp";
import { WELCOME_ART_HEIGHT_PX, WELCOME_ART_WIDTH_PX } from "../../lib/onboardingDisplay";

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
        src={onboardingIntro}
        alt="Blackwell Ops"
        width={WELCOME_ART_WIDTH_PX}
        height={WELCOME_ART_HEIGHT_PX}
        className="setup-welcome-art opacity-90"
        draggable={false}
      />
    </div>
  );
}