// A first visit from a Chinese-language browser goes to the Chinese page.
// Inlined into the English page. Skipped once the visitor has used the
// language link (app.ts records that), and when moving within the site.
declare const SITE_ROOT: string;
declare const ZH_PAGE: string;

try {
  if (
    !localStorage.getItem("tikz-lang") &&
    navigator.language.toLowerCase().startsWith("zh") &&
    !document.referrer.startsWith(SITE_ROOT)
  ) {
    location.replace(ZH_PAGE + location.hash);
  }
} catch {
  // Storage blocked: stay on the English page.
}
