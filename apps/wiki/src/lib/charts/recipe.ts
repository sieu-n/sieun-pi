/**
 * The shared chart recipe (the profile EngagementChart look) as composable ECharts option
 * fragments over ./tokens. echarts-free on purpose, so nothing here pulls the chart runtime into SSR.
 */
import { axisChrome, baseTooltip, type ChartTokens } from './tokens';

type Opt = Record<string, unknown>;

/**
 * Plot frame. `outerBoundsMode/outerBoundsContain` is ECharts 6's form of `containLabel: true`,
 * so axis labels never clip and the paddings stay tight. Leave `bottom` room only for a slider zoom (~46).
 */
export function recipeGrid(o: { top?: number; right?: number; bottom?: number; left?: number } = {}): Opt {
	return {
		top: o.top ?? 12,
		right: o.right ?? 12,
		bottom: o.bottom ?? 8,
		left: o.left ?? 4,
		outerBoundsMode: 'same',
		outerBoundsContain: 'axisLabel',
	};
}

const AXIS_DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Time x-axis for daily-density series. A single function formatter, because ECharts'
 * object-keyed formatter prints a coarser "Jun" right beside "May 29" at a month boundary.
 */
export function timeAxis(t: ChartTokens): Opt {
	const chrome = axisChrome(t);
	return {
		type: 'time',
		axisLine: chrome.axisLine,
		axisTick: { show: false },
		splitLine: { show: false },
		axisLabel: {
			...chrome.axisLabel,
			hideOverlap: true,
			formatter: (value: number) => AXIS_DAY_FORMAT.format(new Date(value)),
		},
	};
}

/** Category x-axis (day buckets, types…) — one hairline, labels only. */
export function categoryAxis(t: ChartTokens, o: { data?: unknown[]; formatter?: (v: string) => string } = {}): Opt {
	const chrome = axisChrome(t);
	return {
		type: 'category',
		...(o.data ? { data: o.data } : {}),
		axisLine: chrome.axisLine,
		axisTick: { show: false },
		splitLine: { show: false },
		axisLabel: { ...chrome.axisLabel, hideOverlap: true, ...(o.formatter ? { formatter: o.formatter } : {}) },
	};
}

/**
 * Value y-axis: no axis line, mono numerals, ~3 splits. `minInterval: 1` for integral units so a
 * short axis never shows 0.5 ticks. `inside: true` draws labels inside the grid edge for a full-bleed plot.
 */
export function valueAxis(
	t: ChartTokens,
	o: {
		formatter?: (v: number) => string;
		min?: number | 'dataMin';
		max?: number | ((extent: { min: number; max: number }) => number);
		log?: boolean;
		minInterval?: number;
		showLabels?: boolean;
		position?: 'left' | 'right';
		inside?: boolean;
	} = {},
): Opt {
	const chrome = axisChrome(t);
	return {
		type: o.log ? 'log' : 'value',
		...(o.position ? { position: o.position } : {}),
		...(o.min !== undefined ? { min: o.min } : {}),
		...(o.max !== undefined ? { max: o.max } : {}),
		...(o.minInterval !== undefined ? { minInterval: o.minInterval } : {}),
		splitNumber: 3,
		axisLine: { show: false },
		axisTick: { show: false },
		splitLine: chrome.splitLine,
		axisLabel: {
			...chrome.axisLabel,
			show: o.showLabels ?? true,
			...(o.inside ? { inside: true, margin: 6 } : {}),
			...(o.formatter ? { formatter: o.formatter } : {}),
		},
	};
}

/** Axis-trigger tooltip with the calm dashed guide (line marks). */
export function axisTooltip(t: ChartTokens, o: { formatter?: unknown } = {}): Opt {
	return {
		...baseTooltip(t),
		trigger: 'axis',
		axisPointer: { type: 'line', lineStyle: { color: t.inkFaint, type: 'dashed' } },
		...(o.formatter ? { formatter: o.formatter } : {}),
	};
}

/** Axis-trigger tooltip for bar marks — a quiet column band, never a glow. */
export function barTooltip(t: ChartTokens, o: { formatter?: unknown } = {}): Opt {
	return {
		...baseTooltip(t),
		trigger: 'axis',
		axisPointer: {
			type: 'shadow',
			shadowStyle: { color: t.dark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,32,0.04)' },
		},
		...(o.formatter ? { formatter: o.formatter } : {}),
	};
}

/** One row of a recipe tooltip: swatch dot, name, mono value, optional sub. */
export type TooltipRow = { swatch?: string; label: string; value: string; sub?: string };

/** The shared tooltip body: title line, swatch-dot rows with mono values, optional ruled footer. */
export function tooltipHtml(
	t: ChartTokens,
	title: string,
	rows: TooltipRow[],
	footer?: { label: string; value: string },
): string {
	const body = rows
		.map(
			(r) =>
				`<div style="display:flex;align-items:center;gap:6px;margin-top:2px">` +
				(r.swatch ? `<span style="width:8px;height:8px;border-radius:99px;background:${r.swatch}"></span>` : '') +
				`<span style="min-width:0">${r.label}</span>` +
				`<b style="margin-left:auto;padding-left:12px;font-family:${t.mono};font-weight:500">${r.value}</b>` +
				(r.sub ? `<span style="font-family:${t.mono};font-size:10px;color:${t.inkFaint}">${r.sub}</span>` : '') +
				// Each row closes its own div, or every row nests inside the one before.
				`</div>`,
		)
		.join('');
	const foot = footer
		? `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;padding-top:5px;border-top:1px solid ${t.rule};font-weight:600"><span>${footer.label}</span><b style="font-family:${t.mono};font-weight:600">${footer.value}</b></div>`
		: '';
	return `<div style="min-width:154px"><span style="color:${t.inkMuted};font-size:11px">${title}</span>${body}${foot}</div>`;
}

/** Quiet legend row — 8px dots, sans labels, sits above the plot. */
export function recipeLegend(t: ChartTokens, o: { show?: boolean } = {}): Opt {
	return {
		show: o.show ?? true,
		top: 4,
		left: 0,
		icon: 'circle',
		itemWidth: 8,
		itemHeight: 8,
		itemGap: 16,
		textStyle: { color: t.inkMuted, fontSize: 11, fontFamily: t.sans },
		inactiveColor: t.inkFaint,
	};
}

/**
 * The line/area mark: thin line, soft fill, no symbols (sparse series pass `symbolSize`).
 * Stacked bands raise `areaOpacity` to ~0.22 so adjacent bands stay separable.
 */
export function lineSeries(
	t: ChartTokens,
	o: {
		data: unknown[];
		name?: string;
		color?: string;
		stack?: string;
		smooth?: boolean;
		width?: number;
		areaOpacity?: number;
		symbolSize?: number;
		showValues?: boolean;
		valueFormatter?: (v: number) => string;
	},
): Opt {
	const color = o.color ?? t.accent;
	const areaOpacity = o.areaOpacity ?? 0.1;
	return {
		type: 'line',
		...(o.name ? { name: o.name } : {}),
		...(o.stack ? { stack: o.stack } : {}),
		smooth: o.smooth ?? true,
		...(o.symbolSize ? { symbol: 'circle', symbolSize: o.symbolSize } : { symbol: 'none' }),
		lineStyle: { color, width: o.width ?? 1.6 },
		itemStyle: { color },
		...(areaOpacity > 0 ? { areaStyle: { color, opacity: areaOpacity } } : {}),
		emphasis: { disabled: false, scale: false },
		label: {
			show: o.showValues ?? false,
			position: 'top',
			fontSize: 9,
			color: t.inkMuted,
			...(o.valueFormatter
				? {
						formatter: (p: { value: number | [unknown, number] }) =>
							o.valueFormatter!(Array.isArray(p.value) ? p.value[1] : p.value),
					}
				: {}),
		},
		data: o.data,
	};
}

/**
 * A dashed horizontal reference line with an inline label. Attach it to exactly one series
 * (`{ ...lineSeries(t, {...}), markLine: goalMarkLine(t, {...}) }`); it spans the whole plot.
 */
export function goalMarkLine(t: ChartTokens, o: { value: number; label: string }): Opt {
	return {
		symbol: 'none',
		silent: true,
		animation: false,
		lineStyle: { color: t.inkFaint, type: 'dashed', width: 1.3 },
		label: {
			show: true,
			position: 'insideEndTop',
			formatter: o.label,
			color: t.inkMuted,
			fontSize: 9.5,
			fontFamily: t.mono,
		},
		data: [{ yAxis: o.value }],
	};
}

/**
 * Stacked bars with the rounded cap on each column's topmost nonzero segment only, because a
 * fixed radius on the last series rounds nothing on days that series is 0.
 */
export function stackedBars(
	series: { name: string; color: string; data: number[] }[],
	o: { stack?: string; barWidth?: string | number; barMaxWidth?: number; capRadius?: number } = {},
): Opt[] {
	const r = o.capRadius ?? 3; // out of scope: a bar corner radius, not a limit
	const cols = series[0]?.data.length ?? 0;
	const topOfColumn: number[] = Array.from({ length: cols }, (_, di) => {
		for (let si = series.length - 1; si >= 0; si--) if ((series[si].data[di] ?? 0) > 0) return si;
		return -1;
	});
	return series.map((s, si) => ({
		name: s.name,
		type: 'bar',
		stack: o.stack ?? 'total',
		barWidth: o.barWidth ?? '58%',
		barMaxWidth: o.barMaxWidth ?? 28,
		itemStyle: { color: s.color },
		emphasis: { disabled: true },
		data: s.data.map((v, di) =>
			topOfColumn[di] === si ? { value: v, itemStyle: { color: s.color, borderRadius: [r, r, 0, 0] } } : v,
		),
	}));
}

/** Donut share — slices separated by surface-coloured borders, no spider
 *  labels (identity lives in the legend/side list + tooltip). */
export function donutSeries(
	t: ChartTokens,
	data: { name: string; value: number; color?: string }[],
	o: { radius?: [string, string] } = {},
): Opt {
	return {
		type: 'pie',
		radius: o.radius ?? ['58%', '82%'],
		avoidLabelOverlap: true,
		itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
		label: { show: false },
		emphasis: { scale: true, scaleSize: 3 },
		data: data.map((d, i) => ({
			name: d.name,
			value: d.value,
			itemStyle: {
				color: d.color ?? t.palette[i % t.palette.length],
				borderColor: t.surface,
				borderWidth: 2,
				borderRadius: 3,
			},
		})),
	};
}

/** Drag-to-narrow, for a chart that fills its own screen. ECharts 6's dataZoom roam controller (roams.js
 *  mergeControllerParams) listens to every wheel over the grid with zoomOnMouseWheel forced on and stops the event
 *  before it checks each dataZoom's own setting, so even `zoomOnMouseWheel: 'ctrl'` keeps the page from scrolling
 *  while the pointer is over the plot. Never put it on a chart inside a page that scrolls. */
export function insideZoom(): Opt {
	return { type: 'inside', throttle: 50 };
}

/** The quiet range slider — pair with insideZoom under a `bottom: 46` grid. */
export function sliderZoom(t: ChartTokens): Opt {
	return {
		type: 'slider',
		height: 20,
		bottom: 6,
		borderColor: 'transparent',
		backgroundColor: 'transparent',
		// Transparent, because `fillerColor` stacked on `selectedDataBackground` reads as one solid band.
		fillerColor: 'transparent',
		handleSize: '60%',
		moveHandleStyle: { color: t.inkFaint, opacity: 0.5 },
		handleStyle: { color: t.inkFaint, borderColor: t.inkFaint },
		dataBackground: { lineStyle: { color: t.rule }, areaStyle: { color: t.rule, opacity: 0.4 } },
		selectedDataBackground: { lineStyle: { color: t.accent }, areaStyle: { color: t.accent, opacity: 0.18 } },
		textStyle: { color: t.inkMuted, fontFamily: t.mono, fontSize: 9.5 },
	};
}

/** A complete sparkline option for stat tiles (~40-56px tall): the recipe line with all chrome off. */
export function sparkOption(t: ChartTokens, o: { data: number[]; color?: string; areaOpacity?: number }): Opt {
	const color = o.color ?? t.accent;
	return {
		animation: false,
		grid: { top: 2, right: 1, bottom: 2, left: 1 },
		xAxis: { type: 'category', show: false },
		yAxis: { type: 'value', show: false },
		tooltip: { show: false },
		series: [
			{
				type: 'line',
				silent: true,
				smooth: true,
				symbol: 'none',
				lineStyle: { color, width: 1.4 },
				itemStyle: { color },
				areaStyle: { color, opacity: o.areaOpacity ?? 0.1 },
				data: o.data,
			},
		],
	};
}
