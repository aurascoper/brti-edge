"use client";

import * as React from "react";
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type AreaData,
} from "lightweight-charts";
import type { TimePoint } from "@polyterminal/types";

export interface CandleChartProps {
  series: TimePoint[];
  height?: number;
  color?: string;
  precision?: number;
  minMove?: number;
}

export function CandleChart({
  series,
  height = 320,
  color = "#fbbf24",
  precision = 4,
  minMove = 0.0001,
}: CandleChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const areaRef = React.useRef<ISeriesApi<"Area"> | null>(null);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f1f23" },
        horzLines: { color: "#1f1f23" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: `${color}33`,
      bottomColor: `${color}05`,
      lineWidth: 2,
      priceFormat: { type: "price", precision, minMove },
      priceLineVisible: false,
    });
    chartRef.current = chart;
    areaRef.current = area;
    return () => {
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
    };
  }, [color, precision, minMove]);

  React.useEffect(() => {
    const s = areaRef.current;
    if (!s) return;
    const data: AreaData[] = series
      .map((p) => ({ time: Math.floor(p.ts / 1000) as UTCTimestamp, value: p.value }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const dedup: AreaData[] = [];
    let lastTs = -Infinity;
    for (const d of data) {
      const t = d.time as number;
      if (t > lastTs) {
        dedup.push(d);
        lastTs = t;
      }
    }
    s.setData(dedup);
  }, [series]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
