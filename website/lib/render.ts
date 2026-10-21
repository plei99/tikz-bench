import {
  color,
  configName,
  type Configuration,
  duration,
  effortName,
  escape,
  formatMetric,
  formatScore,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  modelName,
  money,
  paretoFrontier,
  provider,
  ranked,
  scoreAxis,
  scoreValue,
  type Shape,
  shape,
  type Snapshot,
  type State,
  tokens,
} from "./model";
import { text } from "./i18n";
import { brandLogo } from "./logos";

type Point = [number, number];

// Plot area inside the SVG viewBox; series are labelled in a column at its right.
const width = 960, left = 52, right = 700, top = 36, bottom = 420;
const labelX = right + 28, labelGap = 20;

// Marker centred on (x, y); every shape has roughly the same area.
function marker(kind: Shape, x: number, y: number) {
  if (kind === "square") {
    return `<rect class="marker" x="${x - 4}" y="${
      y - 4
    }" width="8" height="8"/>`;
  }
  if (kind === "triangle") {
    return `<path class="marker" d="M${x} ${y - 5.5}L${x + 5} ${y + 3.5}H${
      x - 5
    }Z"/>`;
  }
  if (kind === "diamond") {
    return `<path class="marker" d="M${x} ${y - 5.5}L${x + 5.5} ${y}L${x} ${
      y + 5.5
    }L${x - 5.5} ${y}Z"/>`;
  }
  return `<circle class="marker" cx="${x}" cy="${y}" r="4.5"/>`;
}

// Moves label baselines apart by at least the label gap, as close as possible
// to where each series ends, and keeps them within the plot's height.
function spreadLabels(wanted: number[]) {
  const order = wanted.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const gap = Math.min(
    labelGap,
    (bottom - top) / Math.max(order.length - 1, 1),
  );
  const ys = order.map(([y]) => y);
  for (let i = 0; i < ys.length; i++) {
    ys[i] = Math.max(ys[i]!, i ? ys[i - 1]! + gap : top);
  }
  for (let i = ys.length - 1; i >= 0; i--) {
    ys[i] = Math.min(ys[i]!, i < ys.length - 1 ? ys[i + 1]! - gap : bottom);
  }
  const placed: number[] = [];
  order.forEach(([, index], i) => placed[index!] = ys[i]!);
  return placed;
}

// A label in the right-hand column, joined to the point (x, y) it names.
const leader = (x: number, y: number, ly: number) =>
  `<path class="leader" d="M${x + 7} ${y}L${labelX - 8} ${ly}H${labelX - 4}"/>`;

// Dashed guides from a point to both axes, each ending in the value it
// reads there. Hidden until the point is hovered or focused.
function crosshair(c: Configuration, [px, py]: Point, state: State) {
  const score = formatScore(scoreValue(c, state.category), state.category);
  const metric = escape(
    formatMetric(
      metricValue(c, state.metric, state.category),
      state.metric,
      state.lang,
      c.cost_sources.includes("lower_bound"),
    ),
  );
  // The metric's label sits right of its guide unless that runs off the plot.
  const flip = px > right - 60;
  return `<g class="crosshair" aria-hidden="true"><path d="M${left} ${py}H${px}M${px} ${py}V${bottom}"/><text x="${
    left + 4
  }" y="${py - 6}">${score}</text><text x="${px + (flip ? -6 : 6)}" y="${
    bottom - 6
  }" text-anchor="${flip ? "end" : "start"}">${metric}</text></g>`;
}

// The card shown beside a hovered point: the configuration and its averages,
// with the two values the chart plots emphasized.
export function tooltip(c: Configuration, state: State) {
  const t = text(state.lang);
  const rows: [string, string, boolean][] = [
    [
      t.scoreTitles[state.category],
      formatScore(scoreValue(c, state.category), state.category),
      true,
    ],
    ...([
      ["cost", t.costPerTask],
      ["output_tokens", t.tokensPerTask],
      ["agent_seconds", t.agentTimePerTask],
    ] as const).map(([m, label]): [string, string, boolean] => [
      label,
      escape(
        formatMetric(
          metricValue(c, m, state.category),
          m,
          state.lang,
          c.cost_sources.includes("lower_bound"),
        ),
      ),
      m === state.metric,
    ]),
  ];
  return `<div class="tip-head" style="color:${color(c)}">${
    brandLogo(provider(c), "tip-logo")
  }<strong>${escape(modelName(c.model))}</strong></div><div class="tip-sub">${
    escape(t.effortAgent(effortName(c, state.lang), c.agent))
  }</div><dl>${
    rows.map(([label, value, plotted]) =>
      `<div${
        plotted ? ' class="plotted"' : ""
      }><dt>${label}</dt><dd>${value}</dd></div>`
    ).join("")
  }</dl><p class="tip-hint">${t.clickForDetails}</p>`;
}

export function chart(data: Snapshot, state: State) {
  const t = text(state.lang);
  const rows = ranked(data, { ...state, sort: "score", ascending: false });
  const points = rows.filter((c) => {
    const value = metricValue(c, state.metric, state.category);
    return value !== null && Number.isFinite(value) && value > 0;
  });
  const metric = metrics[state.metric];
  const values = points.map((c) =>
    metricValue(c, state.metric, state.category)!
  );
  const log = state.scale !== "linear";
  const axis = log
    ? logAxis(values, metric.unit, metric.limit)
    : linearAxis(values, metric.unit, metric.limit);
  const scaleNote = log ? t.logScaleNote : "";
  const yAxis = scoreAxis(points.map((c) => scoreValue(c, state.category)));
  const x = (v: number) => left + axis.position(v) * (right - left);
  const y = (v: number) => bottom - yAxis.position(v) * (bottom - top);
  const at = (c: Configuration): Point => [
    x(metricValue(c, state.metric, state.category)!),
    y(scoreValue(c, state.category)!),
  ];
  const title = t.scoreTitles[state.category];
  const axisTitle = t.metrics[state.metric].axis + scaleNote;
  const grid = yAxis.ticks.map((v) => {
    const py = y(v);
    return `<line class="grid" x1="${left}" y1="${py}" x2="${right}" y2="${py}"/>
      <text class="tick" x="${left - 10}" y="${py + 4}" text-anchor="end">${
      state.category === "taste"
        ? (v * 10).toFixed(1)
        : `${Math.round(v * 100)}%`
    }</text>`;
  }).join("") +
    `<line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>` +
    axis.ticks.map((v) => {
      const px = x(v);
      return `<line class="axis" x1="${px}" y1="${bottom}" x2="${px}" y2="${
        bottom + 5
      }"/>
      <text class="tick" x="${px}" y="${bottom + 22}" text-anchor="middle">${
        escape(
          // Whole-minute ticks need no decimal.
          state.metric === "agent_seconds" && v >= 60 && v % 60 === 0
            ? t.minutes(v / 60)
            : formatMetric(v, state.metric, state.lang),
        )
      }</text>`;
    }).join("");
  const limit = metric.limit
    ? `<line class="limit" x1="${x(metric.limit)}" y1="${top}" x2="${
      x(metric.limit)
    }" y2="${bottom}"/><text class="limit-label" x="${x(metric.limit)}" y="${
      top - 10
    }" text-anchor="end">${t.timeLimit(t.minutes(metric.limit / 60))}</text>`
    : "";
  // Effort levels of one model and agent form a series, joined in cost order
  // and labelled where its most expensive effort ends.
  const groups = new Map<string, Configuration[]>();
  for (const c of points) {
    const key = `${c.model}/${c.agent}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const series = [...groups.values()].map((g) =>
    g.map((c) => ({ c, xy: at(c) })).sort((a, b) => a.xy[0] - b.xy[0])
  );
  const onFrontier = new Set(
    state.frontier ? paretoFrontier(points, state.metric, state.category) : [],
  );
  const frontier = [...onFrontier].map(at);
  const labelY = spreadLabels(series.map((s) => s.at(-1)!.xy[1]));
  const plotted = series.map((s, index) => {
    const c = s[0]!.c, [ex, ey] = s.at(-1)!.xy;
    const line = s.length > 1
      ? `<polyline class="line" points="${
        s.map(({ xy }) => xy.join(",")).join(" ")
      }"/>`
      : "";
    const marks = s.map(({ c, xy }) => {
      const value = `${
        formatScore(scoreValue(c, state.category), state.category)
      }, ${
        escape(
          formatMetric(
            metricValue(c, state.metric, state.category),
            state.metric,
            state.lang,
            c.cost_sources.includes("lower_bound"),
          ),
        )
      }`;
      return `<g class="point${
        onFrontier.has(c) ? " on-frontier" : ""
      }" tabindex="0" role="button" data-config="${escape(c.id)}" aria-label="${
        escape(configName(c, state.lang))
      }: ${value}. ${t.openDetails}">${crosshair(c, xy, state)}${
        marker(shape(c), ...xy)
      }</g>`;
    }).join("");
    const ly = labelY[index]!;
    return `<g class="series${
      s.some(({ c }) => onFrontier.has(c)) ? " on-frontier" : ""
    }" style="color:${color(c)}">${line}${marks}${
      leader(ex, ey, ly)
    }<g class="series-label" transform="translate(${labelX} ${ly})">${
      brandLogo(provider(c), "chart-logo").replace(
        "<svg ",
        '<svg x="0" y="-8" width="16" height="16" ',
      )
    }<text x="22" y="4.5">${
      escape(modelName(c.model))
    }<tspan class="agent" dx="6">${escape(c.agent)}</tspan></text></g></g>`;
  }).join("");
  const pareto = frontier.length > 1
    ? `<g class="pareto-series"><polyline class="pareto" points="${
      frontier.map((xy) => xy.join(",")).join(" ")
    }"/></g>`
    : "";
  const missing = rows.length - points.length;
  return `<svg${
    frontier.length > 1 ? ' class="show-frontier"' : ""
  } viewBox="0 0 ${width} 464" role="img" aria-label="${
    t.chartLabel(title, axisTitle)
  }">
    <text class="axis-title" x="${left}" y="16">${title}</text>
    ${grid}${limit}${pareto}${plotted}
    ${
    points.length
      ? ""
      : `<text class="empty" x="${(left + right) / 2}" y="${
        (top + bottom) / 2
      }" text-anchor="middle">${t.noPoints}</text>`
  }
    <text class="axis-title" x="${(left + right) / 2}" y="${
    bottom + 42
  }" text-anchor="middle">${axisTitle}</text>
  </svg>${
    missing
      ? `<p class="chart-note">${
        t.notPlotted(missing, t.metrics[state.metric].label)
      }</p>`
      : ""
  }`;
}

export function table(data: Snapshot, state: State) {
  const t = text(state.lang);
  const rows = ranked(data, state);
  return rows.length
    ? rows.map((c) => {
      const score = scoreValue(c, state.category);
      return `<tr style="--model:${color(c)}">
    <td><button class="model" data-config="${
        escape(c.id)
      }"><span class="model-name">${brandLogo(provider(c))}${
        escape(modelName(c.model))
      }</span> <span class="effort">[${
        escape(effortName(c, state.lang))
      }]</span> <span class="agent">${
        ["pi", "opencode"].includes(c.agent)
          ? brandLogo(c.agent, "harness-logo")
          : ""
      }${escape(c.agent)}</span></button></td>
    <td class="bar-cell"><span class="bar"><span style="width:${
        score! * 100
      }%"></span></span></td>
    <td class="num score">${formatScore(score, state.category)}</td>
    <td class="num">${
        money(
          metricValue(c, "cost", state.category),
          c.cost_sources.includes("lower_bound"),
        )
      }</td><td class="num">${
        tokens(metricValue(c, "output_tokens", state.category))
      }</td><td class="num">${
        duration(metricValue(c, "agent_seconds", state.category), state.lang)
      }</td>
  </tr>`;
    }).join("")
    : `<tr><td colspan="6" class="empty">${t.noRows}</td></tr>`;
}
