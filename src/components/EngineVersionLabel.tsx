import { engineVersionParts } from "../lib/engineOverview";

/** Version as text, build number as a chip; the commit is never shown. */
export default function EngineVersionLabel({
  version,
}: {
  version: string | null | undefined;
}) {
  const { name, build } = engineVersionParts(version);
  if (!name && !build) return <span className="config-muted">unknown</span>;
  return (
    <span className="eng-version">
      {name && <span>{build ? `version: ${name}` : name}</span>}
      {build && <span className="eng-badge">build: {build}</span>}
    </span>
  );
}
