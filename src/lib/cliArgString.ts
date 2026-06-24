/** Merge tokens split by legacy naive whitespace parsing inside quoted values. */
export function repairBrokenQuotedSubParams(args: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const startsQuoted = arg.startsWith('"') && !arg.endsWith('"');
    if (startsQuoted) {
      const parts = [arg.slice(1)];
      i += 1;
      while (i < args.length && !args[i].endsWith('"')) {
        parts.push(args[i]);
        i += 1;
      }
      if (i < args.length) {
        parts.push(args[i].slice(0, -1));
        i += 1;
      }
      out.push(parts.join(" "));
    } else {
      out.push(arg);
      i += 1;
    }
  }
  return out;
}

/** Parse a space-separated CLI arg string, respecting quoted values. */
export function parseCliArgString(input: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        args.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (cur.length > 0) {
    args.push(cur);
  }

  return args;
}

/** Format argv tokens back into an editable CLI arg string. */
export function formatCliArgString(args: string[]): string {
  return args
    .map((arg) => (/[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}