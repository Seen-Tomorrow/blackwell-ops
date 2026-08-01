import { useEffect, type RefObject } from "react";

/**
 * Pin forecast phosphor height to badge content (layout px).
 * Uses offsetHeight — not getBoundingClientRect — so ancestor transform zoom
 * does not inflate the measured size and amplify bottom slack.
 *
 * Ignores sub-pixel / 1-row noise: only re-pin when height moves by more than
 * `STABILITY_PX` so SOURCE text swaps (formula→learned) don't bounce the bezel.
 */
const STABILITY_PX = 8;

export function useForecastContentHeight(
  rootRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  contentKey: string,
): void {
  useEffect(() => {
    if (!active) return;

    const badge = rootRef.current;
    if (!badge) return;

    const display = badge.closest(".vram-forecast-display");
    if (!(display instanceof HTMLElement)) return;

    const frame = badge.closest(".industrial-display-frame");

    let raf = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let lastPinned = 0;

    const applyHeight = (h: number) => {
      lastPinned = h;
      display.dataset.contentHeightManaged = "";
      display.style.height = `${h}px`;
      display.style.minHeight = `${h}px`;
      display.style.maxHeight = `${h}px`;
      if (frame instanceof HTMLElement) {
        frame.dataset.contentHeightManaged = "";
        frame.style.minHeight = "0";
      }
    };

    const sync = (force = false) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (display.dataset.fusionHeightManaged !== undefined) return;
        const h = badge.offsetHeight;
        if (h <= 0) {
          // Onboarding → forecast swap can measure before layout settles.
          if (retryCount < 8) {
            retryCount += 1;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => sync(true), 50 * retryCount);
          }
          return;
        }
        retryCount = 0;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        // Skip tiny height chatter (SOURCE line count used to move phosphor by ~1 row).
        if (!force && lastPinned > 0 && Math.abs(h - lastPinned) < STABILITY_PX) {
          return;
        }
        applyHeight(h);
      });
    };

    const onResize = () => sync(true);
    const ro = new ResizeObserver(() => sync(false));
    ro.observe(badge);

    const shell = badge.closest(".app-shell");
    const zoomObserver =
      shell instanceof HTMLElement
        ? new MutationObserver(onResize)
        : null;
    zoomObserver?.observe(shell!, { attributes: true, attributeFilter: ["style"] });

    window.addEventListener("resize", onResize);
    // contentKey change / mount: force pin to measured height
    lastPinned = 0;
    sync(true);

    return () => {
      cancelAnimationFrame(raf);
      if (retryTimer) clearTimeout(retryTimer);
      ro.disconnect();
      zoomObserver?.disconnect();
      window.removeEventListener("resize", onResize);
      delete display.dataset.contentHeightManaged;
      if (display.dataset.fusionHeightManaged === undefined) {
        display.style.height = "";
        display.style.minHeight = "";
        display.style.maxHeight = "";
      }
      if (frame instanceof HTMLElement) {
        delete frame.dataset.contentHeightManaged;
        frame.style.minHeight = "";
      }
    };
  }, [active, contentKey]);
}