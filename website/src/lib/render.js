import {
  color,
  configName,
  duration,
  escape,
  formatMetric,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  money,
  paretoFrontier,
  percent,
  ranked,
  scoreAxis,
  scoreValue,
  shape,
  tokens,
} from "./model.js";

// Plot area inside the SVG viewBox.
const left = 52, right = 900, top = 36, bottom = 420;

// Marker centred on (x, y); every shape has roughly the same area.
function marker(kind, x, y) {
  if (kind === "square") {
    return `<rect class="marker" x="${x - 4.5}" y="${
      y - 4.5
    }" width="9" height="9"/>`;
  }
  if (kind === "triangle") {
    return `<path class="marker" d="M${x} ${y - 6}L${x + 5.5} ${y + 4}H${
      x - 5.5
    }Z"/>`;
  }
  if (kind === "diamond") {
    return `<path class="marker" d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${
      y + 6
    }L${x - 6} ${y}Z"/>`;
  }
  return `<circle class="marker" cx="${x}" cy="${y}" r="5"/>`;
}

// Places each effort label beside its point where it overlaps no marker, line,
// other label or the plot edge. Labels with no free spot are left to the tooltip.
function placeLabels(items, segments) {
  const boxes = items.map(({ x, y }) => [x - 7, y - 7, x + 7, y + 7]);
  // Lines are sampled every few pixels; exact segment clipping is not needed.
  const samples = segments.flatMap(([x1, y1, x2, y2]) => {
    const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 3);
    return Array.from({ length: n + 1 }, (_, i) => [
      x1 + (x2 - x1) * i / n,
      y1 + (y2 - y1) * i / n,
    ]);
  });
  const overlaps = (a) =>
    a[0] < left || a[2] > right + 16 || a[1] < top - 16 || a[3] > bottom ||
    boxes.some((b) =>
      a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
    ) ||
    samples.some(([sx, sy]) =>
      sx > a[0] && sx < a[2] && sy > a[1] && sy < a[3]
    );
  return items.map(({ x, y, text }) => {
    const w = text.length * 6.6, h = 11;
    // [box left, baseline, anchor], tried in order: above, below, right, left.
    const spots = [
      [x - w / 2, y - 10, "middle"],
      [x - w / 2, y + 19, "middle"],
      [x + 10, y + 4, "start"],
      [x - 10 - w, y + 4, "end"],
      [x + 6, y - 9, "start"],
      [x + 6, y + 18, "start"],
      [x - 6 - w, y - 9, "end"],
      [x - 6 - w, y + 18, "end"],
    ];
    for (const [bx, baseline, anchor] of spots) {
      const box = [bx - 1, baseline - h + 2, bx + w + 1, baseline + 2];
      if (overlaps(box)) continue;
      boxes.push(box);
      const tx = anchor === "middle"
        ? bx + w / 2
        : anchor === "end"
        ? bx + w
        : bx;
      return `<text class="effort" x="${tx}" y="${baseline}" text-anchor="${anchor}">${
        escape(text)
      }</text>`;
    }
    return "";
  });
}

export function chart(data, state) {
  const rows = ranked(data, { ...state, sort: "score", ascending: false });
  const points = rows.filter((c) =>
    Number.isFinite(metricValue(c, state.metric)) &&
    metricValue(c, state.metric) > 0
  );
  const metric = metrics[state.metric];
  const values = points.map((c) => metricValue(c, state.metric));
  const log = state.scale !== "linear";
  const axis = log ? logAxis(values) : linearAxis(values, metric.unit);
  const scaleNote = log ? " (log scale)" : "";
  const yAxis = scoreAxis(points.map((c) => scoreValue(c, state.category)));
  const x = (v) => left + axis.position(v) * (right - left);
  const y = (v) => bottom - yAxis.position(v) * (bottom - top);
  const title = {
    overall: "Score",
    handwritten: "Hand-drawn score",
    digital: "Digital score",
  }[state.category];
  const grid = yAxis.ticks.map((v) => {
    const py = y(v);
    return `<line class="grid" x1="${left}" y1="${py}" x2="${right}" y2="${py}"/>
      <text class="tick" x="${left - 10}" y="${py + 4}" text-anchor="end">${
      Math.round(v * 100)
    }%</text>`;
  }).join("") + axis.ticks.map((v) => {
    const px = x(v);
    return `<line class="grid" x1="${px}" y1="${top}" x2="${px}" y2="${bottom}"/>
      <text class="tick" x="${px}" y="${bottom + 20}" text-anchor="middle">${
      escape(formatMetric(v, state.metric))
    }</text>`;
  }).join("");
  // Effort levels of one model and agent are joined, as in a cost/score frontier.
  const groups = new Map();
  for (const c of points) {
    const key = `${c.model}/${c.agent}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const paths = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    color: color(g[0]),
    coords: g.map((c) => [
      x(metricValue(c, state.metric)),
      y(scoreValue(c, state.category)),
    ]).sort((a, b) => a[0] - b[0]),
  }));
  const lines = paths.map(({ color, coords }) =>
    `<polyline class="frontier" style="color:${color}" points="${
      coords.map(([px, py]) => `${px},${py}`).join(" ")
    }"/>`
  ).join("");
  const frontier = state.frontier
    ? paretoFrontier(points, state.metric, state.category).map((c) => [
      x(metricValue(c, state.metric)),
      y(scoreValue(c, state.category)),
    ])
    : [];
  const pareto = frontier.length > 1
    ? `<polyline class="pareto" points="${
      frontier.map(([px, py]) => `${px},${py}`).join(" ")
    }"/>`
    : "";
  const segments = [...paths.map(({ coords }) => coords), frontier].flatMap((
    coords,
  ) => coords.slice(1).map(([px, py], i) => [...coords[i], px, py]));
  const xy = points.map((c) => ({
    x: x(metricValue(c, state.metric)),
    y: y(scoreValue(c, state.category)),
    text: c.effort ?? "default",
  }));
  const labels = placeLabels(xy, segments);
  const plotted = points.map((c, index) => {
    const value = `${percent(scoreValue(c, state.category))}, ${
      escape(formatMetric(metricValue(c, state.metric), state.metric))
    }`;
    return `<g class="point" tabindex="0" role="button" data-config="${
      escape(c.id)
    }" aria-label="${
      escape(configName(c))
    }: ${value}. Open details." style="color:${color(c)}">
      <title>${escape(configName(c))}: ${value}</title>
      ${marker(shape(c), xy[index].x, xy[index].y)}
    </g>`;
  }).join("");
  const legend =
    [...groups.values()].map(([c]) =>
      `<li><svg viewBox="0 0 24 14" aria-hidden="true" style="color:${
        color(c)
      }"><line class="frontier" x1="0" y1="7" x2="24" y2="7"/>${
        marker(shape(c), 12, 7)
      }</svg>${escape(c.model)} <span class="agent">${
        escape(c.agent)
      }</span></li>`
    ).join("") + (pareto
      ? `<li><svg viewBox="0 0 24 14" aria-hidden="true"><line class="pareto" x1="0" y1="7" x2="24" y2="7"/></svg>Pareto frontier</li>`
      : "");
  const missing = rows.length - points.length;
  return `${
    points.length ? `<ul class="legend">${legend}</ul>` : ""
  }<svg viewBox="0 0 920 464" role="img" aria-label="${title} against ${metric.axis}${scaleNote}">
    <text class="axis-title" x="${left}" y="16">${title}</text>
    ${grid}${lines}${pareto}${plotted}${labels.join("")}
    ${
    points.length
      ? ""
      : `<text class="empty" x="${(left + right) / 2}" y="${
        (top + bottom) / 2
      }" text-anchor="middle">No configurations to plot</text>`
  }
    <text class="axis-title" x="${(left + right) / 2}" y="${
    bottom + 40
  }" text-anchor="middle">${metric.axis}${scaleNote}</text>
  </svg>${
    missing
      ? `<p class="chart-note">${missing} run${
        missing > 1 ? "s" : ""
      } without positive recorded ${
        metrics[state.metric].label.toLowerCase()
      } appear only in the table.</p>`
      : ""
  }`;
}

export function table(data, state) {
  const rows = ranked(data, state);
  return rows.length
    ? rows.map((c) => {
      const score = scoreValue(c, state.category);
      return `<tr style="--model:${color(c)}">
    <td><button class="model" data-config="${escape(c.id)}"><span>${
        escape(c.model)
      }</span> <span class="effort">[${
        escape(c.effort ?? "default")
      }]</span> <span class="agent">${escape(c.agent)}</span></button></td>
    <td class="bar-cell"><span class="bar"><span style="width:${
        score * 100
      }%"></span></span></td>
    <td class="num score">${percent(score)}</td>
    <td class="num">${money(c.cost)}</td><td class="num">${
        tokens(c.output_tokens)
      }</td><td class="num">${duration(c.agent_seconds)}</td>
  </tr>`;
    }).join("")
    : '<tr><td colspan="6" class="empty">No completed configurations selected.</td></tr>';
}
