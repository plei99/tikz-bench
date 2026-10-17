// Apply the theme before first paint. Inlined into each page's head.
//
// The page follows the system setting. A choice made with the toggle is saved
// with the system setting it was made under and applies only while that
// setting holds; a change of the system setting, here or between visits, puts
// the system's theme back. app.ts saves the choice and watches the setting.
const root = document.documentElement;
root.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";
try {
  const system = localStorage.getItem("tikz-theme-system");
  if ((system || root.dataset.theme) === root.dataset.theme) {
    root.dataset.theme = localStorage.getItem("tikz-theme") ||
      root.dataset.theme;
  } else {
    localStorage.removeItem("tikz-theme");
    localStorage.removeItem("tikz-theme-system");
  }
} catch {
  // Storage blocked: keep the system's theme.
}
