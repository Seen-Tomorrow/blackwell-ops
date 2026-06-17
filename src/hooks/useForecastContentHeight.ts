import { useEffect, type RefObject } from "react";

/**
 * Pin forecast phosphor height to badge content (layout px).
 * Uses offsetHeight — not getBoundingClientRect — so ancestor transform zoom
 * does not inflate the measured size and amplify bottom slack.
 */
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
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = badge.offsetHeight;
        if (h <= 0) return;
        display.dataset.contentHeightManaged = "";
        display.style.height = `${h}px`;
        display.style.minHeight = `${h}px`;
        display.style.maxHeight = `${h}px`;
        if (frame instanceof HTMLElement) {
          frame.dataset.contentHeightManaged = "";
          frame.style.minHeight = "0";
        }
      });
    };

    const ro = new ResizeObserver(sync);
    ro.observe(badge);

    const shell = badge.closest(".app-shell");
    const zoomObserver =
      shell instanceof HTMLElement
        ? new MutationObserver(sync)
        : null;
    zoomObserver?.observe(shell!, { attributes: true, attributeFilter: ["style"] });

    window.addEventListener("resize", sync);
    sync();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      zoomObserver?.disconnect();
      window.removeEventListener("resize", sync);
      delete display.dataset.contentHeightManaged;
      display.style.height = "";
      display.style.minHeight = "";
      display.style.maxHeight = "";
      if (frame instanceof HTMLElement) {
        delete frame.dataset.contentHeightManaged;
        frame.style.minHeight = "";
      }
    };
  }, [active, contentKey]);
}