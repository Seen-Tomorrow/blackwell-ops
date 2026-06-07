import IntelWidget from "./IntelWidget";

/** Dedicated feed tab — room for more sections alongside llama.cpp GitHub intel later. */
export default function IntelPage() {
  return (
    <div className="h-full flex flex-col p-4 gap-3 min-h-0" data-intel-page>
      <div className="flex-shrink-0">
        <h2 className="text-xs font-mono text-nv-green tracking-wider">INTEL</h2>
        <p className="text-[9px] font-mono text-stealth-muted/60 mt-1">
          llama.cpp backend news — discussions &amp; pull requests from GitHub
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <IntelWidget />
      </div>
    </div>
  );
}