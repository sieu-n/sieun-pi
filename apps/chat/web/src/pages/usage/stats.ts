/** Pure sums for the Usage page: totals, per chat, per model, per kind and the daily chart series. Every sum is exact (c191). */
import type { UsageReport, UsageRow } from "$lib/api";

export const KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Kind = (typeof KINDS)[number];
export type Tokens = UsageRow["tokens"];
export type Cost = UsageRow["cost"];
export type UsageDay = UsageReport["days"][number];

export interface Total {
  readonly turns: number;
  readonly tokens: Tokens;
  readonly cost: Cost;
}

export interface ChatTotal extends Total {
  readonly thread: string;
  readonly name: string;
  readonly host: string;
  /** The model that cost the most in this chat. */
  readonly model: string;
}

export interface ModelTotal extends Total {
  readonly model: string;
}

export const KIND_LABEL: Readonly<Record<Kind, string>> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };

export const ZERO: Total = { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function add(a: Total, b: Total): Total {
  return {
    turns: a.turns + b.turns,
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
}

/** Every row summed once, then grouped per chat and per model, costliest first. */
export function summarize(rows: readonly UsageRow[]): Summary {
  let total = ZERO;
  const chats = new Map<string, { name: string; host: string; total: Total; byModel: Map<string, number> }>();
  const models = new Map<string, Total>();
  for (const row of rows) {
    const part: Total = { turns: row.turns, tokens: row.tokens, cost: row.cost };
    total = add(total, part);
    const chat = chats.get(row.thread) ?? { name: row.threadName, host: row.host, total: ZERO, byModel: new Map<string, number>() };
    chat.total = add(chat.total, part);
    chat.byModel.set(row.model, (chat.byModel.get(row.model) ?? 0) + row.cost.total);
    chats.set(row.thread, chat);
    models.set(row.model, add(models.get(row.model) ?? ZERO, part));
  }
  const costliest = (a: Total, b: Total) => b.cost.total - a.cost.total || tokenSum(b.tokens) - tokenSum(a.tokens);
  const top = (byModel: Map<string, number>) => [...byModel].reduce((best, entry) => (entry[1] > best[1] ? entry : best), ["", -1] as [string, number])[0];
  return {
    total,
    chats: [...chats].map(([thread, chat]) => ({ thread, name: chat.name, host: chat.host, ...chat.total, model: top(chat.byModel) })).sort(costliest),
    models: [...models].map(([model, sum]) => ({ model, ...sum })).sort(costliest),
  };
}

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly models: readonly string[];
}

/** The chart's own colors; a fourth model and later share the last one as Other. */
export const SERIES = 4;

/** One series per model, costliest first, with every model past the third folded into Other. */
export function seriesOf(models: readonly string[]): Series[] {
  const own = models.length > SERIES ? models.slice(0, SERIES - 1) : models;
  const rest = models.slice(own.length);
  return [
    ...own.map((model, index) => ({ key: model, label: modelName(model), color: `var(--chart-series-${index + 1})`, models: [model] })),
    ...(rest.length ? [{ key: "other", label: "Other", color: `var(--chart-series-${SERIES})`, models: rest }] : []),
  ];
}

/** Each day's cost per series, in series order. */
export function dayCells(days: readonly UsageDay[], series: readonly Series[]): number[][] {
  return days.map(day => series.map(line => line.models.reduce((sum, model) => sum + (day.byModel[model] ?? 0), 0)));
}

/** Models by their cost over the days, costliest first, for a stable color per model. */
export function modelsByCost(days: readonly UsageDay[]): string[] {
  const sums = new Map<string, number>();
  for (const day of days) for (const [model, cost] of Object.entries(day.byModel)) sums.set(model, (sums.get(model) ?? 0) + cost);
  return [...sums].sort((a, b) => b[1] - a[1]).map(([model]) => model);
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
