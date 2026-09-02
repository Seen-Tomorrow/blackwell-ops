import SegmentSwitch from "./SegmentSwitch";
import { useTheme } from "../context/ThemeContext";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useIndustrialBezelTexture } from "../context/IndustrialBezelTextureContext";
import { APP_THEMES } from "../themes/app-themes";
import {
  DISPLAY_TEXTURE_ORDER,
  DISPLAY_TEXTURE_SHORT_LABELS,
  type DisplayTexture,
} from "../lib/displayTexture";
import {
  INDUSTRIAL_BEZEL_TEXTURE_ORDER,
  INDUSTRIAL_BEZEL_TEXTURE_SHORT_LABELS,
  type IndustrialBezelTexture,
} from "../lib/industrialBezelTexture";

/**
 * Header Quick Settings — appearance row.
 *
 * Every control is the shared compact `SegmentSwitch` (same chrome language as
 * the cockpit VISION / FLASH flags), so no `|` separators and no
 * "Quick Settings" caption are needed to read the well.
 */
export default function AppearanceControls() {
  const { theme, setThemeId } = useTheme();
  const { texture: displayTexture, label: displayLabel, setTexture: setDisplayTexture } = useDisplayTexture();
  const { texture: frameTexture, label: frameLabel, setTexture: setFrameTexture } = useIndustrialBezelTexture();


  return (
    <div
      className="app-appearance-panel app-appearance-panel--embedded"
      role="group"
      aria-label="Appearance"
    >
      <div className="app-appearance-section app-appearance-section--inline app-quick-settings__appearance flex items-center gap-1 min-w-0">
        <div className="app-appearance-inline-group flex items-center gap-0.5 min-w-0">
          {/*
           * No THEME / DISPLAY / FRAME captions: each track is already labelled
           * by its own option names (MATRIX·SLATE·ARCTIC, DOTTED·CLEAN,
           * GRIT·BRUSH·DIAMOND), and the three segment tracks read as separate
           * controls. Captions were pure width in a row that must stay on one
           * line — identity + current value live in title / aria-label instead.
           */}
          <SegmentSwitch
            ariaLabel="Theme"
            title={`Theme: ${theme.name}`}
            size="compact"
            tone="accent"
            className="app-quick-settings__seg"
            options={APP_THEMES.map((t) => ({
              id: t.id,
              label: t.name,
              title: t.description,
            }))}
            selectedId={theme.id}
            onSelect={setThemeId}
          />
        </div>
        <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
          <SegmentSwitch
            ariaLabel="Display texture"
            title={`Display texture: ${displayLabel}`}
            size="compact"
            tone="accent"
            className="app-quick-settings__seg"
            options={DISPLAY_TEXTURE_ORDER.map((t) => ({
              id: t,
              label: DISPLAY_TEXTURE_SHORT_LABELS[t],
            }))}
            selectedId={displayTexture}
            onSelect={(id) => setDisplayTexture(id as DisplayTexture)}
          />
        </div>
        <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
          <SegmentSwitch
            ariaLabel="Bezel texture"
            title={`Bezel texture: ${frameLabel}`}
            size="compact"
            tone="accent"
            className="app-quick-settings__seg"
            options={INDUSTRIAL_BEZEL_TEXTURE_ORDER.map((t) => ({
              id: t,
              label: INDUSTRIAL_BEZEL_TEXTURE_SHORT_LABELS[t],
            }))}
            selectedId={frameTexture}
            onSelect={(id) => setFrameTexture(id as IndustrialBezelTexture)}
          />
        </div>
      </div>
    </div>
  );
}
