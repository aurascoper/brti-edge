"use client";

import * as React from "react";
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type LineData,
} from "lightweight-charts";
import type { TimePoint } from "@polyterminal/types";

export interface LineChartProps {
  series: TimePoint[];
  color?: string;
  height?: number;
  precision?: number;
  minMove?: number;
}

export function LineChart({
  series,
  color = "#22d3ee",
  height = 200,
  precision = 4,
  minMove = 0.0001,
}: LineChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const seriesRef = React.useRef<ISeriesApi<"Line"> | null>(null);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const lineSeries = chart.addSeries(LineSeries, {
      color,
      lineWidth: 2,
      priceFormat: { type: "price", precision, minMove },
      lastValueVisible: true,
      priceLineVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = lineSeries;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [color, precision, minMove]);

  React.useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const data: LineData[] = series
      .map((p) => ({ time: Math.floor(p.ts / 1000) as UTCTimestamp, value: p.value }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const dedup: LineData[] = [];
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
