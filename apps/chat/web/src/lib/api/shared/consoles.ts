/**
 * The consoles table: every console, dashboard and database login per tier, from auto-sns-agent's apps/infra/metal/config/consoles.json, the
 * one file the wiki page domains/devops/consoles and the Consoles section of Settings both render. GET /api/consoles serves it
 * (server/consoles.ts). The file holds key names for logins, never a secret value. `parseConsoles` keeps every row it can read and fills a
 * missing field with its empty value, so a row the file adds or a field it skips never blanks the table.
 */

/** A login as the file names it: a literal user, a key in a dotenvx file, or a docker-compose variable. */
export type ConsoleRef = { literal: string } | { file: string; key: string } | { compose: string };

export type ConsoleOpen = {
  kind: "open";
  url: string | null;
  /** A command to run before the url opens, such as an ssh port forward. */
  tunnel: string | null;
  /** The TablePlus group the entry sits in. */
  tableplus: string | null;
  access: "ro" | "rw" | null;
  signIn: string | null;
  user: ConsoleRef | null;
  secret: ConsoleRef | null;
  note: string | null;
};

/** A tier's cell: no console there (with why), the cell of another tier of the same row, or a console to open. */
export type ConsoleCell = { kind: "none"; text: string } | { kind: "same"; tier: string } | ConsoleOpen;

export type ConsoleRow = { id: string; name: string; group: string; cells: Record<string, ConsoleCell> };

export type ConsoleTier = { id: string; name: string };

/** `logins` is the command that prints a console's user and password from the key names, when the file names one. */
export type ConsoleTable = { tiers: ConsoleTier[]; rows: ConsoleRow[]; logins: string | null };

/** What GET /api/consoles answers: the table, or why the file did not read, and the file it read. */
export type ConsolesReport = { table: ConsoleTable | null; readError: string | null; file: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function ref(value: unknown): ConsoleRef | null {
  const literal = text(value);
  if (literal) return { literal };
  const r = record(value);
  if (!r) return null;
  const compose = text(r.compose);
  if (compose) return { compose };
  const file = text(r.file);
  const key = text(r.key);
  return file && key ? { file, key } : null;
}

function cell(value: unknown): ConsoleCell {
  const r = record(value);
  if (!r) return { kind: "none", text: "" };
  const same = text(r.same_as);
  if (same) return { kind: "same", tier: same };
  const url = text(r.url);
  const tunnel = text(r.tunnel);
  const tableplus = text(r.tableplus);
  if (!url && !tunnel && !tableplus) return { kind: "none", text: text(r.none) ?? "" };
  const access = r.access === "ro" || r.access === "rw" ? r.access : null;
  return { kind: "open", url, tunnel, tableplus, access, signIn: text(r.sign_in), user: ref(r.user), secret: ref(r.secret), note: text(r.note) };
}

/** The table from the file's JSON, or null when it holds no tier list or no console list. */
export function parseConsoles(raw: unknown): ConsoleTable | null {
  const r = record(raw);
  if (!r || !Array.isArray(r.tiers) || !Array.isArray(r.consoles)) return null;
  const names = record(r.tier_names) ?? {};
  const tiers = r.tiers.flatMap((t) => (text(t) ? [{ id: t as string, name: text(names[t as string]) ?? (t as string) }] : []));
  const rows = r.consoles.flatMap((c): ConsoleRow[] => {
    const row = record(c);
    const id = text(row?.id);
    if (!row || !id) return [];
    const cells = record(row.cells) ?? {};
    return [{ id, name: text(row.name) ?? id, group: text(row.group) ?? "other", cells: Object.fromEntries(tiers.map((t) => [t.id, cell(cells[t.id])])) }];
  });
  return { tiers, rows, logins: text(r.logins) };
}

/** A tier's cell with `same` followed once to the tier it names, and that tier's id when it was followed. */
export function resolveCell(row: ConsoleRow, tier: string): { cell: ConsoleOpen | { kind: "none"; text: string }; sameAs: string | null } {
  const own = row.cells[tier] ?? { kind: "none", text: "" };
  if (own.kind !== "same") return { cell: own, sameAs: null };
  const target = row.cells[own.tier];
  return { cell: target && target.kind !== "same" ? target : { kind: "none", text: "" }, sameAs: own.tier };
}

/** The rows grouped by `group`, groups in the order each first shows in the file and rows in file order. */
export function groupRows(rows: ConsoleRow[]): { group: string; rows: ConsoleRow[] }[] {
  const runs: { group: string; rows: ConsoleRow[] }[] = [];
  for (const row of rows) {
    const run = runs.find((r) => r.group === row.group);
    if (run) run.rows.push(row);
    else runs.push({ group: row.group, rows: [row] });
  }
  return runs;
}

/** How a login reads in a cell: the literal user, or the key and the file it sits in. */
export function refText(value: ConsoleRef): string {
  if ("literal" in value) return value.literal;
  if ("compose" in value) return `${value.compose} (docker-compose.yml)`;
  return `${value.key} (${value.file})`;
}
