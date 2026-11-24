/** Pure sums for the Usage page: totals, per chat, per model, per client, per kind and the chart series. Every sum is exact (c191). */
import type { UsageReport, UsageRow, UsageSeries, UsageSplit } from "$lib/api";
import { USAGE_CHART_SERIES } from "$lib/api/shared/usage-range";

export const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Kind = (typeof KINDS)[number];
export type Tokens = UsageRow["tokens"];
export type Cost = UsageRow["cost"];
export type UsageBucketSum = UsageReport["buckets"][number];

export interface Total {
  readonly turns: number;
  /** Turns with no recorded cost and no price: their tokens count, and their cost is unknown, not zero. */
  readonly unpriced: number;
  readonly tokens: Tokens;
  readonly cost: Cost;
}

export interface ChatTotal extends Total {
  /** "" for the row that holds every chat past the report's costliest. */
  readonly thread: string;
  readonly name: string;
  readonly host: string;
  readonly client: string;
  /** The model that cost the most in this chat. */
  readonly model: string;
}

export interface ModelTotal extends Total {
  readonly model: string;
}

/** One chat client on one host: pi-host, prime, claude-code, codex, aside, vent and more. */
export interface ClientTotal extends Total {
  readonly client: string;
  readonly host: string;
}

export const KIND_LABEL: Readonly<Record<Kind, string>> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };

export const ZERO: Total = { turns: 0, unpriced: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function add(a: Total, b: Total): Total {
  return {
    turns: a.turns + b.turns,
    unpriced: a.unpriced + b.unpriced,
    tokens: { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output, cacheRead: a.tokens.cacheRead + b.tokens.cacheRead, cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite },
    cost: {
      input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total,
    },
  };
}

export const tokenSum = (tokens: Tokens): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

/** Cache read over every prompt token (input, cache read, cache write); null when nothing was prompted. */
export function cacheHit(tokens: Tokens): number | null {
  const prompted = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompted > 0 ? tokens.cacheRead / prompted : null;
}

export interface Summary {
  readonly total: Total;
  readonly chats: readonly ChatTotal[];
  readonly models: readonly ModelTotal[];
  readonly clients: readonly ClientTotal[];
}

/** Every row summed once, then grouped per chat, per model and per client on its host, costliest first. */
export function summarize(rows: readonly UsageRow[]): Summary {
  let total = ZERO;
  const chats = new Map<string, { name: string; host: string; client: string; total: Total; byModel: Map<string, number> }>();
  const models = new Map<string, Total>();
  const clients = new Map<string, { client: string; host: string; total: Total }>();
  for (const row of rows) {
    // A report stored before 11-24 has rows with no client and no unpriced count; every such row came from pi-host with its own cost.
    const client = row.client ?? "pi-host";
    const part: Total = { turns: row.turns, unpriced: row.unpriced ?? 0, tokens: row.tokens, cost: row.cost };
    total = add(total, part);
    const chat = chats.get(row.thread) ?? { name: row.threadName, host: row.host, client, total: ZERO, byModel: new Map<string, number>() };
    chat.total = add(chat.total, part);
    chat.byModel.set(row.model, (chat.byModel.get(row.model) ?? 0) + row.cost.total);
    chats.set(row.thread, chat);
    models.set(row.model, add(models.get(row.model) ?? ZERO, part));
    const at = `${client}\u0000${row.host}`;
    const own = clients.get(at) ?? { client, host: row.host, total: ZERO };
    own.total = add(own.total, part);
    clients.set(at, own);
  }
  const costliest = (a: Total, b: Total) => b.cost.total - a.cost.total || tokenSum(b.tokens) - tokenSum(a.tokens);
  const top = (byModel: Map<string, number>) => [...byModel].reduce((best, entry) => (entry[1] > best[1] ? entry : best), ["", -1] as [string, number])[0];
  return {
    total,
    chats: [...chats].map(([thread, chat]) => ({ thread, name: chat.name, host: chat.host, client: chat.client, ...chat.total, model: top(chat.byModel) })).sort(costliest),
    models: [...models].map(([model, sum]) => ({ model, ...sum })).sort(costliest),
    clients: [...clients.values()].map(({ client, host, total: sum }) => ({ client, host, ...sum })).sort(costliest),
  };
}

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly models: readonly string[];
}

/** The chart's own colors; the report folds a fourth model or client and later into one Other series. */
export const SERIES = USAGE_CHART_SERIES;

/** What the chart's stacks split by: each model, or each chat client. */
export type Split = UsageSplit;

/** One chart series per report series, costliest first, with the report's Other last. */
export function seriesOf(lines: readonly Pick<UsageSeries, "key" | "others">[], split: Split = "model"): Series[] {
  return lines.map((line, index) => (line.others
    ? { key: "other", label: "Other", color: `var(--chart-series-${SERIES})`, models: [line.key] }
    : { key: line.key, label: split === "model" ? modelName(line.key) : line.key, color: `var(--chart-series-${index + 1})`, models: [line.key] }));
}

/** What the chart counts: dollars, or tokens. */
export type Unit = "usd" | "tokens";
/** Which tokens count: every kind, or output only. */
export type Metric = "total" | "output";
export type Measure = { readonly unit: "usd" } | { readonly unit: "tokens"; readonly metric: Metric };

export const METRIC_LABEL: Readonly<Record<Metric, string>> = { total: "Total", output: "Output" };
export const metricOf = (tokens: Tokens, metric: Metric): number => (metric === "output" ? tokens.output : tokenSum(tokens));

/** Each bucket's measure per chart series, in series order, from the report's columns for its own split. */
export function cellsOf(report: UsageReport, series: readonly Series[], measure: Measure): number[][] {
  const columns = new Map((report.series ?? []).map(line => [line.key, measure.unit === "usd" ? line.cost : measure.metric === "output" ? line.output : line.tokens]));
  return report.buckets.map((_, index) => series.map(line => line.models.reduce((sum, key) => sum + (columns.get(key)?.[index] ?? 0), 0)));
}

/** The axis top and its ticks: the smallest 1, 2, 2.5 or 5 times a power of ten at or above `max`, cut in four. */
export function axis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const quarter = max / 4;
  const power = 10 ** Math.floor(Math.log10(quarter));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= quarter) ?? 10 * power;
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { top, ticks };
}

/** A model id as people say it: the provider prefix and a date suffix dropped, "claude-opus-5-5" as "Opus 5.5". */
export function modelName(model: string): string {
  const bare = model.replace(/^[a-z0-9-]+\//i, "").replace(/-\d{8}$/, "");
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i.exec(bare);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = /^gpt-(.+)$/i.exec(bare);
  if (gpt) return `GPT-${gpt[1]}`;
  return bare;
}
