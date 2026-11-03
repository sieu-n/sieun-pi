/**
 * Design-token bridge for the shared ECharts host, with no echarts import so option factories stay SSR-safe.
 * `readTokens` reads from a scope element (the chart's host node), because `/sieun` themes a `.mkt[data-theme]`
 * div rather than `<html>`, and custom properties inherit down to any descendant.
 */

export interface ChartTokens {
	dark: boolean;
	ink: string;
	inkMuted: string;
	inkFaint: string;
	rule: string;
	surface: string;
	surfaceAlt: string;
	accent: string;
	positive: string;
	mono: string;
	sans: string;
	/** Categorical series hues — dataviz-validated per mode, fixed order. */
	palette: string[];
	/** Neutral fold-in color for an "Other" series. */
	other: string;
	/** Sequential ocean ramp, light→dark reading order for the mode. */
	seq: string[];
	/**
	 * The billing stacked-by-type ramp — `--color-chart-t1..t7` from theme.css
	 * (one ocean hue, light→dark, own validated dark steps). Falls back to
	 * `seq` when the vars are unreadable for the mode (see readTokens).
	 */
	ramp: string[];
	/** Refund-credit mark — `--color-chart-credit`, falling back to positive. */
	credit: string;
}

/** Validated with the dataviz palette validator (ALL PASS, 2026-08-06). The cool family runs first and the
 *  warm amber is the tail slot, so a 2-series chart never jumps from ocean to mustard. */
const PALETTE_LIGHT = ['#0077C0', '#0F8A6D', '#7C5CE0', '#C4386B', '#B45309'];
const PALETTE_DARK = ['#1E8FD5', '#189A82', '#8F6FF0', '#DD5590', '#C58208'];

const SEQ_LIGHT = ['#E8F2FA', '#BBDDF1', '#84BFE2', '#4C9DD0', '#1F7DB9', '#0B5D91'];
const SEQ_DARK = ['#13293C', '#1A4260', '#215E88', '#2F80B2', '#4FA5DA', '#82C6F0'];

function cssVar(styles: CSSStyleDeclaration, name: string): string {
	return styles.getPropertyValue(name).trim();
}

export function readTokens(scope: Element = document.documentElement): ChartTokens {
	const styles = getComputedStyle(scope);
	const themeRoot = scope.closest('[data-theme]') as HTMLElement | null;
	const dark = themeRoot?.dataset.theme === 'dark';
	// `--color-chart-*` are themed by `html[data-theme='dark']` only. Under a `.mkt` dark scope they resolve to
	// the light values (t7 #072d43 is invisible on graphite), so trust them only under the html scope.
	const varsThemed = !themeRoot || themeRoot === document.documentElement;
	const rampVars = varsThemed
		? [1, 2, 3, 4, 5, 6, 7].map((i) => cssVar(styles, `--color-chart-t${i}`)).filter(Boolean)
		: [];
	const positive = cssVar(styles, '--color-positive');
	return {
		dark,
		ink: cssVar(styles, '--color-ink'),
		inkMuted: cssVar(styles, '--color-ink-muted'),
		inkFaint: cssVar(styles, '--color-ink-faint'),
		rule: cssVar(styles, '--color-rule'),
		surface: cssVar(styles, '--color-surface'),
		surfaceAlt: cssVar(styles, '--color-surface-alt'),
		accent: cssVar(styles, '--color-accent'),
		positive,
		mono: cssVar(styles, '--font-mono') || 'ui-monospace, monospace',
		sans: cssVar(styles, '--font-sans') || 'system-ui, sans-serif',
		palette: dark ? PALETTE_DARK : PALETTE_LIGHT,
		other: cssVar(styles, '--color-ink-faint'),
		seq: dark ? SEQ_DARK : SEQ_LIGHT,
		ramp: rampVars.length === 7 ? rampVars : dark ? SEQ_DARK : SEQ_LIGHT,
		credit: (varsThemed && cssVar(styles, '--color-chart-credit')) || positive,
	};
}

/** The canonical tooltip shell — matches the app's menu recipe. */
export function baseTooltip(t: ChartTokens): Record<string, unknown> {
	return {
		trigger: 'item',
		backgroundColor: t.surface,
		borderColor: t.rule,
		borderWidth: 1,
		borderRadius: 6,
		padding: [7, 10],
		textStyle: { color: t.ink, fontSize: 12, fontFamily: t.sans },
		extraCssText: 'box-shadow: 0 4px 18px rgba(16,18,23,0.09); z-index: 210;',
	};
}

/** Shared cartesian axis chrome — recessive rules, mono numerals. */
export function axisChrome(t: ChartTokens): {
	axisLine: Record<string, unknown>;
	axisTick: Record<string, unknown>;
	axisLabel: Record<string, unknown>;
	splitLine: Record<string, unknown>;
} {
	return {
		axisLine: { lineStyle: { color: t.rule } },
		axisTick: { show: false },
		axisLabel: { color: t.inkMuted, fontSize: 10.5, fontFamily: t.mono },
		splitLine: { lineStyle: { color: t.rule, opacity: 0.6 } },
	};
}

/** Format a number the way the app renders data numerals. */
export function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}K`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(Math.round(n));
}
