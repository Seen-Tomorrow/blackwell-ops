/** True when the scalar looks like a plain integer or decimal literal. */
function isNumericLiteral(v: string | number): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t);
}

function asSortableNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(String(v).trim());
}

/** Natural order for param value chips — numeric literals by magnitude, else localeCompare. */
export function compareParamValues(a: string | number, b: string | number): number {
  const sa = String(a);
  const sb = String(b);
  const aNum = isNumericLiteral(a);
  const bNum = isNumericLiteral(b);
  if (aNum && bNum) return asSortableNumber(a) - asSortableNumber(b);
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}

export function sortParamValues(values: (string | number)[]): (string | number)[] {
  if (values.length < 2) return [...values];
  return [...values].sort(compareParamValues);
}