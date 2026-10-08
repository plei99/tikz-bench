import {
  configName,
  duration,
  effortName,
  escape,
  initialState,
  matchesFilters,
  money,
  percent,
  tokens,
} from "./lib/model.js";
import { chart, table } from "./lib/render.js";
import { text } from "./lib/i18n.js";

const lang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
const t = text(lang);
const data = JSON.parse(document.querySelector("#benchmark-data").textContent);
const state = initialState(data, lang);
const $ = (selector) => document.querySelector(selector);
const available = () =>
  data.configurations.filter((c) =>
    c.complete && !c.pilot && c.cohort_id === state.cohort
  );
// Runs the filter dialog lists: those matching its facets and search text.
const listed = () => {
  const query = $("#config-search").value.toLowerCase().trim();
  return available().filter((c) =>
    matchesFilters(c, state.filters) &&
    configName(c, lang).toLowerCase().includes(query)
  );
};

function render() {
  $("#chart").innerHTML = chart(data, state);
  $("#leaderboard-body").innerHTML = table(data, state);
  const configs = available();
  $("#config-count").textContent = `(${
    configs.filter((c) =>
      state.selected.includes(c.id) && matchesFilters(c, state.filters)
    ).length
  }/${configs.length})`;
  $("[data-frontier]").setAttribute("aria-pressed", String(state.frontier));
  for (const button of document.querySelectorAll("[data-filter]")) {
    const selected = state.filters[button.dataset.filter];
    button.setAttribute(
      "aria-pressed",
      String(
        button.dataset.value
          ? selected.includes(button.dataset.value)
          : !selected.length,
      ),
    );
  }
  for (const group of ["metric", "category", "efforts", "scale"]) {
    for (const button of document.querySelectorAll(`[data-${group}]`)) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset[group] === state[group]),
      );
    }
  }
  for (const button of document.querySelectorAll("[data-sort]")) {
    const active = button.dataset.sort === state.sort;
    if (active) {
      button.closest("th").setAttribute(
        "aria-sort",
        state.ascending ? "ascending" : "descending",
      );
    } else button.closest("th").removeAttribute("aria-sort");
    button.querySelector("span").textContent = active
      ? (state.ascending ? "↑" : "↓")
      : "";
  }
}

function renderPicker() {
  const rows = listed();
  $("#config-options").innerHTML =
    rows.map((c) =>
      `<label><input type="checkbox" value="${escape(c.id)}" ${
        state.selected.includes(c.id) ? "checked" : ""
      }> ${escape(c.model)} (${escape(effortName(c, lang))}), ${
        escape(c.agent)
      }</label>`
    ).join("") || `<p>${t.noRunsMatch}</p>`;
}

function detail(id) {
  const c = data.configurations.find((c) => c.id === id);
  if (!c) return;
  const cohort = data.cohorts.find((cohort) => cohort.id === c.cohort_id);
  $("#detail-title").textContent = `${c.model} (${effortName(c, lang)})`;
  $("#detail-content").innerHTML = `<p>${
    t.runWith(escape(c.agent), percent(c.score))
  }</p>
    <table><tbody>${
    [
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
      [t.costPerTask, money(c.cost)],
      [t.tokensPerTask, tokens(c.output_tokens)],
      [t.agentTimePerTask, duration(c.agent_seconds, lang)],
      [t.responseTimePerTask, duration(c.api_seconds, lang)],
      [t.compileRate, percent(c.compile_rate)],
    ].map(([label, value]) =>
      `<tr><th scope="row">${label}</th><td>${value}</td></tr>`
    ).join("")
  }</tbody></table>`;
  $("#detail-dialog").showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(
    "[data-metric], [data-category], [data-efforts], [data-scale], [data-frontier], [data-filter], [data-sort], [data-config], [data-close]",
  );
  if (!button) return;
  if (button.dataset.filter) {
    // "All" clears the facet; any other value toggles in or out of it.
    const { filter, value } = button.dataset;
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
  for (const key of ["metric", "category", "efforts", "scale"]) {
    if (button.dataset[key]) {
      state[key] = button.dataset[key];
      render();
      return;
    }
  }
  if (button.dataset.sort) {
    const key = button.dataset.sort;
    state.ascending = state.sort === key
      ? !state.ascending
      : !["score", "compile_rate"].includes(key);
    state.sort = key;
    render();
  }
  if (button.dataset.config) detail(button.dataset.config);
  if (button.hasAttribute("data-close")) button.closest("dialog").close();
});

document.addEventListener("keydown", (event) => {
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches(".point")
  ) {
    event.preventDefault();
    detail(event.target.dataset.config);
  }
});

$("#cohort-select")?.addEventListener("change", (event) => {
  state.cohort = event.target.value;
  render();
});
$("#config-picker").addEventListener("click", () => {
  renderPicker();
  $("#config-dialog").showModal();
});
$("#config-search").addEventListener("input", renderPicker);
$("#config-options").addEventListener("change", (event) => {
  const checkbox = event.target;
  state.selected = state.selected.filter((id) => id !== checkbox.value);
  if (checkbox.checked) state.selected.push(checkbox.value);
  render();
});
$("#select-all").addEventListener("click", () => {
  state.selected = [
    ...new Set([...state.selected, ...listed().map((c) => c.id)]),
  ];
  renderPicker();
  render();
});
$("#select-none").addEventListener("click", () => {
  const ids = listed().map((c) => c.id);
  state.selected = state.selected.filter((id) => !ids.includes(id));
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
// A choice is saved with the system setting it was made under. The inline
// script in <head> applies it only while that setting holds; a change of the
// system setting, here or between visits, puts the system's theme back.
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
$("#lang-switch").addEventListener("click", (event) => {
  try {
    localStorage.setItem("tikz-lang", event.currentTarget.hreflang.slice(0, 2));
  } catch { /* Storage may be unavailable in private browsing. */ }
  event.currentTarget.hash = location.hash;
});
render();
