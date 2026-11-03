/** The full ECharts registration, loaded dynamically by EChart.svelte so the runtime never runs in SSR. */
import * as echarts from 'echarts/core';
import {
	BarChart,
	BoxplotChart,
	EffectScatterChart,
	GraphChart,
	HeatmapChart,
	LineChart,
	MapChart,
	PieChart,
	ScatterChart,
	ThemeRiverChart,
	TreemapChart,
} from 'echarts/charts';
import {
	CalendarComponent,
	DataZoomInsideComponent,
	DataZoomSliderComponent,
	GeoComponent,
	GridComponent,
	LegendComponent,
	MarkAreaComponent,
	MarkLineComponent,
	SingleAxisComponent,
	ToolboxComponent,
	TooltipComponent,
	VisualMapContinuousComponent,
	VisualMapPiecewiseComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
	LineChart,
	BarChart,
	PieChart,
	ScatterChart,
	EffectScatterChart,
	MapChart,
	HeatmapChart,
	BoxplotChart,
	TreemapChart,
	ThemeRiverChart,
	GraphChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	DataZoomInsideComponent,
	DataZoomSliderComponent,
	VisualMapContinuousComponent,
	VisualMapPiecewiseComponent,
	CalendarComponent,
	SingleAxisComponent,
	GeoComponent,
	MarkLineComponent,
	MarkAreaComponent,
	// Drag-select zoom: the toolbox dataZoom feature with hidden icons, armed
	// through `takeGlobalCursor` after render (workpool home charts).
	ToolboxComponent,
	CanvasRenderer,
]);

export { echarts };
