import {
  type Configuration,
  duration,
  effortName,
  escape,
  type Facet,
  formatScore,
  initialState,
  matchesFilters,
  metricValue,
  modelName,
  money,
  percent,
  scoreValue,
  setupKey,
  setupName,
  type Snapshot,
  type State,
  tokens,
} from "../lib/model";
import { chart, table, tooltip } from "../lib/render";
import { type Lang, text } from "../lib/i18n";
import { validateSnapshot } from "../scripts/validate";

// The leaderboard's controls. The page arrives fully rendered; this re-renders
// the chart and table from the embedded snapshot whenever a control changes.
const lang: Lang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
const t = text(lang);
const snapshot: unknown = JSON.parse($("#benchmark-data").textContent!);
validateSnapshot(snapshot);
const data = snapshot as Snapshot;
const state = initialState(data, lang);
function $<E extends Element = HTMLElement>(selector: string) {
  return document.querySelector<E>(selector)!;
}
const available = () =>
  data.configurations.filter((c) =>
    c.complete && !c.pilot && c.cohort_id === state.cohort
  );
// One run per model+harness setup, standing for all of its efforts.
const setups = (configs: Configuration[]) => [
  ...new Map(configs.map((c) => [setupKey(c), c])).values(),
];
// Setups the filter dialog lists: those matching its facets and search text.
const listed = () => {
  const query = $<HTMLInputElement>("#config-search").value.toLowerCase()
    .trim();
  return setups(available().filter((c) => matchesFilters(c, state.filters)))
    .filter((c) =>
      setupName(c).toLowerCase().includes(query) ||
      c.model.toLowerCase().includes(query)
    );
};

const groups = ["metric", "category", "efforts", "scale"] as const;

function render() {
  hideTip();
  $("#chart").innerHTML = chart(data, state);
  $("#leaderboard-body").innerHTML = table(data, state);
  const all = setups(available());
  $("#config-count").textContent = `(${
    all.filter((c) =>
      state.selected.includes(setupKey(c)) && matchesFilters(c, state.filters)
    ).length
  }/${all.length})`;
  $("[data-frontier]").setAttribute("aria-pressed", String(state.frontier));
  for (
    const button of document.querySelectorAll<HTMLElement>("[data-filter]")
  ) {
    const selected = state.filters[button.dataset.filter as Facet];
    button.setAttribute(
      "aria-pressed",
      String(
        button.dataset.value
          ? selected.includes(button.dataset.value)
          : !selected.length,
      ),
    );
  }
  for (const group of groups) {
    for (
      const button of document.querySelectorAll<HTMLElement>(`[data-${group}]`)
    ) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset[group] === state[group]),
      );
    }
  }
  for (const button of document.querySelectorAll<HTMLElement>("[data-sort]")) {
    const active = button.dataset.sort === state.sort;
    const th = button.closest("th")!;
    if (active) {
      th.setAttribute(
        "aria-sort",
        state.ascending ? "ascending" : "descending",
      );
    } else th.removeAttribute("aria-sort");
    button.querySelector("span")!.textContent = active
      ? (state.ascending ? "↑" : "↓")
      : "";
  }
}

function renderPicker() {
  const rows = listed();
  $("#config-options").innerHTML =
    rows.map((c) =>
      `<label><input type="checkbox" value="${escape(setupKey(c))}" ${
        state.selected.includes(setupKey(c)) ? "checked" : ""
      }> ${escape(setupName(c))}</label>`
    ).join("") || `<p>${t.noRunsMatch}</p>`;
}

function detail(id: string) {
  const c = data.configurations.find((c) => c.id === id);
  if (!c) return;
  const cohort = data.cohorts.find((cohort) => cohort.id === c.cohort_id)!;
  $("#detail-title").textContent = `${modelName(c.model)} (${
    effortName(c, lang)
  })`;
  $("#detail-content").innerHTML = `<p>${
    t.runWith(
      escape(c.agent),
      formatScore(scoreValue(c, state.category), state.category),
    )
  }</p>
    <table><tbody>${
    [
      [t.taste, formatScore(scoreValue(c, "taste"), "taste")],
      [
        t.handwrittenCount(cohort.handwritten),
        t.fullCredit(
          percent(c.handwritten_score),
          c.handwritten_perfect ?? "—",
        ),
      ],
      [
        t.digitalCount(cohort.digital),
        t.exact(percent(c.digital_score), c.digital_perfect ?? "—"),
      ],
      [
        t.costPerTask,
        money(
          metricValue(c, "cost", state.category),
          c.cost_sources.includes("lower_bound"),
        ),
      ],
      [
        t.tokensPerTask,
        tokens(metricValue(c, "output_tokens", state.category)),
      ],
      [
        t.agentTimePerTask,
        duration(metricValue(c, "agent_seconds", state.category), lang),
      ],
      [
        t.responseTimePerTask,
        duration(metricValue(c, "api_seconds", state.category), lang),
      ],
      [t.compileRate, percent(c.compile_rate)],
    ].map(([label, value]) =>
      `<tr><th scope="row">${label}</th><td>${value}</td></tr>`
    ).join("")
  }</tbody></table>`;
  $<HTMLDialogElement>("#detail-dialog").showModal();
}

// The tooltip card sits beside the hovered (or keyboard-focused) point, on
// whichever side has room within the chart panel.
function showTip(point: HTMLElement) {
  const c = data.configurations.find((c) => c.id === point.dataset.config);
  if (!c) return;
  const tip = $("#chart-tip");
  tip.innerHTML = tooltip(c, state);
  tip.hidden = false;
  const panel = tip.offsetParent!.getBoundingClientRect();
  const mark = point.querySelector(".marker")!.getBoundingClientRect();
  const gap = 14;
  const cx = mark.left + mark.width / 2 - panel.left;
  const cy = mark.top + mark.height / 2 - panel.top;
  const room = panel.width - cx - gap;
  const x = room >= tip.offsetWidth ? cx + gap : cx - gap - tip.offsetWidth;
  const y = Math.min(
    Math.max(cy - tip.offsetHeight / 2, 8),
    panel.height - tip.offsetHeight - 8,
  );
  tip.style.left = `${Math.max(x, 8)}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  $("#chart-tip").hidden = true;
}
const target = (event: Event) => event.target as HTMLElement;
$("#chart").addEventListener("pointerover", (event) => {
  const point = target(event).closest<HTMLElement>(".point");
  if (point && event.pointerType !== "touch") showTip(point);
});
$("#chart").addEventListener("pointerout", (event) => {
  if (target(event).closest(".point")) hideTip();
});
$("#chart").addEventListener("focusin", (event) => {
  if (target(event).matches(".point:focus-visible")) showTip(target(event));
});
$("#chart").addEventListener("focusout", hideTip);
$("#chart").addEventListener("scroll", hideTip);

document.addEventListener("click", (event) => {
  const button = target(event).closest<HTMLElement>(
    "[data-metric], [data-category], [data-efforts], [data-scale], [data-frontier], [data-filter], [data-sort], [data-config], [data-close]",
  );
  if (!button) return;
  if (button.dataset.filter) {
    // "All" clears the facet; any other value toggles in or out of it.
    const filter = button.dataset.filter as Facet, value = button.dataset.value;
    const selected = state.filters[filter];
    state.filters[filter] = !value
      ? []
      : selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    render();
    renderPicker();
    return;
  }
  if (button.hasAttribute("data-frontier")) {
    state.frontier = !state.frontier;
    render();
    return;
  }
  for (const key of groups) {
    if (button.dataset[key]) {
      (state[key] as string) = button.dataset[key];
      render();
      return;
    }
  }
  if (button.dataset.sort) {
    const key = button.dataset.sort as State["sort"];
    state.ascending = state.sort === key ? !state.ascending : key !== "score";
    state.sort = key;
    render();
  }
  if (button.dataset.config) {
    hideTip();
    detail(button.dataset.config);
  }
  if (button.hasAttribute("data-close")) button.closest("dialog")!.close();
});

document.addEventListener("keydown", (event) => {
  if (
    (event.key === "Enter" || event.key === " ") &&
    target(event).matches(".point")
  ) {
    event.preventDefault();
    detail(target(event).dataset.config!);
  }
});

document.querySelector("#cohort-select")?.addEventListener(
  "change",
  (event) => {
    state.cohort = (event.target as HTMLSelectElement).value;
    render();
  },
);
$("#config-picker").addEventListener("click", () => {
  renderPicker();
  $<HTMLDialogElement>("#config-dialog").showModal();
});
$("#config-search").addEventListener("input", renderPicker);
$("#config-options").addEventListener("change", (event) => {
  const checkbox = event.target as HTMLInputElement;
  state.selected = state.selected.filter((key) => key !== checkbox.value);
  if (checkbox.checked) state.selected.push(checkbox.value);
  render();
});
$("#select-all").addEventListener("click", () => {
  state.selected = [
    ...new Set([...state.selected, ...listed().map(setupKey)]),
  ];
  renderPicker();
  render();
});
$("#select-none").addEventListener("click", () => {
  const keys = listed().map(setupKey);
  state.selected = state.selected.filter((key) => !keys.includes(key));
  renderPicker();
  render();
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left || event.clientX > r.right ||
        event.clientY < r.top || event.clientY > r.bottom
      ) dialog.close();
    }
  });
}

function themeLabel() {
  const next = document.documentElement.dataset.theme === "dark"
    ? "light"
    : "dark";
  $("#theme-toggle").setAttribute("aria-label", t.themeLabel(next));
}
// A choice is saved with the system setting it was made under; the inline
// script in <head> (client/inline/theme.ts) applies it only while that setting
// holds. A change of the system setting while the page is open puts the
// system's theme back.
const system = matchMedia("(prefers-color-scheme: dark)");
const systemTheme = () => system.matches ? "dark" : "light";
$("#theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark"
    ? "light"
    : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("tikz-theme", theme);
    localStorage.setItem("tikz-theme-system", systemTheme());
  } catch { /* Storage may be unavailable in private browsing. */ }
  themeLabel();
});
system.addEventListener("change", () => {
  document.documentElement.dataset.theme = systemTheme();
  try {
    localStorage.removeItem("tikz-theme");
    localStorage.removeItem("tikz-theme-system");
  } catch { /* Storage may be unavailable in private browsing. */ }
  themeLabel();
});
themeLabel();
// The other language keeps the current section, and the choice outlasts the
// browser-language redirect on the English page.
const link = $<HTMLAnchorElement>("#lang-switch");
link.addEventListener("click", () => {
  try {
    localStorage.setItem("tikz-lang", link.hreflang.slice(0, 2));
  } catch { /* Storage may be unavailable in private browsing. */ }
  link.hash = location.hash;
});
render();
