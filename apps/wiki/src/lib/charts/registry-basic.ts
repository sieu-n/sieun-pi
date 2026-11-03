/**
 * Minimal ECharts registration (line/area, bar, axis tooltip, legend, zoom), the default `EChart` preset.
 * The full registry costs ~1.3MB and 2.1s of skeleton on /sieun/tokens, so an exotic chart type uses
 * `preset="full"` on that one chart instead of joining this file.
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
	DataZoomInsideComponent,
	DataZoomSliderComponent,
	GridComponent,
	LegendComponent,
	MarkAreaComponent,
	MarkLineComponent,
	TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
	LineChart,
	BarChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	DataZoomInsideComponent,
	DataZoomSliderComponent,
	MarkLineComponent,
	MarkAreaComponent,
	CanvasRenderer,
]);

export { echarts };
