/** True when the scalar looks like a plain integer or decimal literal. */
export function isNumericLiteral(v: string | number): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t);
}

function asSortableNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(String(v).trim());
}

/** Compare numeric literals by magnitude (enum/string lists should not use this). */
export function compareParamValues(a: string | number, b: string | number): number {
  return asSortableNumber(a) - asSortableNumber(b);
}

/**
 * Sort only pure numeric value lists (ctx steps, batch sizes).
 * String enums keep factory/JSON declaration order (ON/OFF, layer/none/tensor, …).
 */
export function sortParamValues(values: (string | number)[]): (string | number)[] {
  if (values.length < 2) return [...values];
  if (!values.every(isNumericLiteral)) return [...values];
  return [...values].sort(compareParamValues);
}