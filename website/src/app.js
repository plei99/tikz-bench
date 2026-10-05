import {
  configName,
  duration,
  escape,
  initialState,
  money,
  percent,
  tokens,
} from "./lib/model.js";
import { chart, progress, table } from "./lib/render.js";

const data = JSON.parse(document.querySelector("#benchmark-data").textContent);
const state = initialState(data);
const $ = (selector) => document.querySelector(selector);
const available = () =>
  data.configurations.filter((c) =>
    c.complete && !c.pilot && c.cohort_id === state.cohort
  );

function render() {
  $("#chart").innerHTML = chart(data, state);
  $("#leaderboard-body").innerHTML = table(data, state);
  $("#progress-list").innerHTML = progress(data, state);
  const configs = available();
  $("#config-count").textContent = `(${
    configs.filter((c) => state.selected.includes(c.id)).length
  }/${configs.length})`;
  $("#pending-count").textContent = String(
    data.configurations.filter((c) =>
      !c.complete && c.cohort_id === state.cohort
    ).length,
  );
  const cohort = data.cohorts.find((c) => c.id === state.cohort);
  $("#task-stat").textContent = cohort.tasks;
  $("#handwritten-stat").textContent = cohort.handwritten;
  $("#digital-stat").textContent = cohort.digital;
  $("#model-stat").textContent = new Set(configs.map((c) => c.model)).size;
  $("[data-frontier]").setAttribute("aria-pressed", String(state.frontier));
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
  const query = $("#config-search").value.toLowerCase().trim();
  const rows = available().filter((c) =>
    configName(c).toLowerCase().includes(query)
  );
  $("#config-options").innerHTML =
    rows.map((c) =>
      `<label><input type="checkbox" value="${escape(c.id)}" ${
        state.selected.includes(c.id) ? "checked" : ""
      }> ${escape(c.model)} (${escape(c.effort ?? "default")}), ${
        escape(c.agent)
      }</label>`
    ).join("") || "<p>No runs match.</p>";
}

function detail(id) {
  const c = data.configurations.find((c) => c.id === id);
  if (!c) return;
  const cohort = data.cohorts.find((cohort) => cohort.id === c.cohort_id);
  $("#detail-title").textContent = `${c.model} (${c.effort ?? "default"})`;
  $("#detail-content").innerHTML = `<p>Run with ${escape(c.agent)}. Score ${
    percent(c.score)
  }.</p>
    <table><tbody>${
    [
      [
        `Hand-drawn (${cohort.handwritten})`,
        `${percent(c.handwritten_score)}, ${
          c.handwritten_perfect ?? "—"
        } with full credit`,
      ],
      [
        `Digital (${cohort.digital})`,
        `${percent(c.digital_score)}, ${c.digital_perfect ?? "—"} exact`,
      ],
      ["Cost per task", money(c.cost)],
      ["Output tokens per task", tokens(c.output_tokens)],
      ["Agent time per task", duration(c.agent_seconds)],
      ["Model response time per task", duration(c.api_seconds)],
      ["Compile rate", percent(c.compile_rate)],
    ].map(([label, value]) =>
      `<tr><th scope="row">${label}</th><td>${value}</td></tr>`
    ).join("")
  }</tbody></table>`;
  $("#detail-dialog").showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(
    "[data-metric], [data-category], [data-efforts], [data-scale], [data-frontier], [data-sort], [data-config], [data-close]",
  );
  if (!button) return;
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
    ...new Set([...state.selected, ...available().map((c) => c.id)]),
  ];
  renderPicker();
  render();
});
$("#select-none").addEventListener("click", () => {
  const ids = available().map((c) => c.id);
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
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${next} theme`);
}
$("#theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark"
    ? "light"
    : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("tikz-theme", theme);
  } catch { /* Storage may be unavailable in private browsing. */ }
  themeLabel();
});
themeLabel();
render();
