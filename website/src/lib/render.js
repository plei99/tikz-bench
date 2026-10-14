import {
  color,
  configName,
  duration,
  effortName,
  escape,
  formatMetric,
  formatScore,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  money,
  paretoFrontier,
  provider,
  ranked,
  scoreAxis,
  scoreValue,
  shape,
  tokens,
} from "./model.js";
import { text } from "./i18n.js";
import { brandLogo } from "./logos.js";

// Plot area inside the SVG viewBox; series are labelled in a column at its right.
const width = 960, left = 52, right = 700, top = 36, bottom = 420;
const labelX = right + 28, labelGap = 20;

// Marker centred on (x, y); every shape has roughly the same area.
function marker(kind, x, y) {
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
function spreadLabels(wanted) {
  const order = wanted.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const gap = Math.min(
    labelGap,
    (bottom - top) / Math.max(order.length - 1, 1),
  );
  const ys = order.map(([y]) => y);
  for (let i = 0; i < ys.length; i++) {
    ys[i] = Math.max(ys[i], i ? ys[i - 1] + gap : top);
  }
  for (let i = ys.length - 1; i >= 0; i--) {
    ys[i] = Math.min(ys[i], i < ys.length - 1 ? ys[i + 1] - gap : bottom);
  }
  const placed = [];
  order.forEach(([, index], i) => placed[index] = ys[i]);
  return placed;
}

// A label in the right-hand column, joined to the point (x, y) it names.
const leader = (x, y, ly) =>
  `<path class="leader" d="M${x + 7} ${y}L${labelX - 8} ${ly}H${labelX - 4}"/>`;

export function chart(data, state) {
  const t = text(state.lang);
  const rows = ranked(data, { ...state, sort: "score", ascending: false });
  const points = rows.filter((c) =>
    Number.isFinite(metricValue(c, state.metric, state.category)) &&
    metricValue(c, state.metric, state.category) > 0
  );
  const metric = metrics[state.metric];
  const values = points.map((c) =>
    metricValue(c, state.metric, state.category)
  );
  const log = state.scale !== "linear";
  const axis = log ? logAxis(values) : linearAxis(values, metric.unit);
  const scaleNote = log ? t.logScaleNote : "";
  const yAxis = scoreAxis(points.map((c) => scoreValue(c, state.category)));
  const x = (v) => left + axis.position(v) * (right - left);
  const y = (v) => bottom - yAxis.position(v) * (bottom - top);
  const at = (c) => [
    x(metricValue(c, state.metric, state.category)),
    y(scoreValue(c, state.category)),
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
        escape(formatMetric(v, state.metric, state.lang))
      }</text>`;
    }).join("");
  // Effort levels of one model and agent form a series, joined in cost order
  // and labelled where its most expensive effort ends.
  const groups = new Map();
  for (const c of points) {
    const key = `${c.model}/${c.agent}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const series = [...groups.values()].map((g) =>
    g.map((c) => ({ c, xy: at(c) })).sort((a, b) => a.xy[0] - b.xy[0])
  );
  const frontier = state.frontier
    ? paretoFrontier(points, state.metric, state.category).map(at)
    : [];
  const ends = [
    ...series.map((s) => s.at(-1).xy),
    ...(frontier.length > 1 ? [frontier.at(-1)] : []),
  ];
  const labelY = spreadLabels(ends.map(([, py]) => py));
  const plotted = series.map((s, index) => {
    const c = s[0].c, [ex, ey] = s.at(-1).xy;
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
          ),
        )
      }`;
      return `<g class="point" tabindex="0" role="button" data-config="${
        escape(c.id)
      }" aria-label="${
        escape(configName(c, state.lang))
      }: ${value}. ${t.openDetails}">
      <title>${escape(configName(c, state.lang))}: ${value}</title>
      ${marker(shape(c), ...xy)}
    </g>`;
    }).join("");
    const ly = labelY[index];
    return `<g class="series" style="color:${color(c)}">${line}${marks}${
      leader(ex, ey, ly)
    }<g class="series-label" transform="translate(${labelX} ${ly})">${
      brandLogo(provider(c), "chart-logo").replace(
        "<svg ",
        '<svg x="0" y="-8" width="16" height="16" ',
      )
    }<text x="22" y="4.5">${escape(c.model)}<tspan class="agent" dx="6">${
      escape(c.agent)
    }</tspan></text></g></g>`;
  }).join("");
  const pareto = frontier.length > 1
    ? `<g class="pareto-series"><polyline class="pareto" points="${
      frontier.map((xy) => xy.join(",")).join(" ")
    }"/>${
      leader(...frontier.at(-1), labelY.at(-1))
    }<g transform="translate(${labelX} ${
      labelY.at(-1)
    })"><line class="pareto" x1="0" y1="0" x2="16" y2="0"/><text x="22" y="4.5">${t.paretoFrontier}</text></g></g>`
    : "";
  const missing = rows.length - points.length;
  return `<svg viewBox="0 0 ${width} 464" role="img" aria-label="${
    t.chartLabel(title, axisTitle)
  }">
    <text class="axis-title" x="${left}" y="16">${title}</text>
    ${grid}${pareto}${plotted}
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

export function table(data, state) {
  const t = text(state.lang);
  const rows = ranked(data, state);
  return rows.length
    ? rows.map((c) => {
      const score = scoreValue(c, state.category);
      return `<tr style="--model:${color(c)}">
    <td><button class="model" data-config="${
        escape(c.id)
      }"><span class="model-name">${brandLogo(provider(c))}${
        escape(c.model)
      }</span> <span class="effort">[${
        escape(effortName(c, state.lang))
      }]</span> <span class="agent">${
        ["pi", "opencode"].includes(c.agent)
          ? brandLogo(c.agent, "harness-logo")
          : ""
      }${escape(c.agent)}</span></button></td>
    <td class="bar-cell"><span class="bar"><span style="width:${
        score * 100
      }%"></span></span></td>
    <td class="num score">${formatScore(score, state.category)}</td>
    <td class="num">${
        money(metricValue(c, "cost", state.category))
      }</td><td class="num">${
        tokens(metricValue(c, "output_tokens", state.category))
      }</td><td class="num">${
        duration(metricValue(c, "agent_seconds", state.category), state.lang)
      }</td>
  </tr>`;
    }).join("")
    : `<tr><td colspan="6" class="empty">${t.noRows}</td></tr>`;
}
