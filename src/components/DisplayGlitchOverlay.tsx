/** Decorative CRT-style glitch layers — only visible under [data-display-texture="glitch"]. */
export default function DisplayGlitchOverlay() {
  return (
    <div className="display-glitch-fx" aria-hidden="true">
      <span className="display-glitch-ambient" />
      <span className="display-glitch-chroma" />
      <span className="display-glitch-block display-glitch-block--1" />
      <span className="display-glitch-block display-glitch-block--2" />
      <span className="display-glitch-block display-glitch-block--3" />
      <span className="display-glitch-block display-glitch-block--4" />
    </div>
  );
}