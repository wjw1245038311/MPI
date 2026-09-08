/**
 * User stylesheet (custom.css): inject the main-process-provided content into a
 * <style> tag appended at the end of <head>, i.e. after every built-in
 * stylesheet — user rules win at equal specificity. Live-updates on change
 * events pushed by the main process; no restart needed.
 */
const STYLE_ID = "mpi-custom-css";

function apply(content: string | undefined): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = content ?? "";
}

export function startCustomCss(): void {
  window.pi.settings
    .getCustomCss()
    .then((r) => apply(r?.content))
    .catch(() => {}); // main not ready / no file yet — the change event catches up
  window.pi.on.customCss((p) => apply(p?.content));
}
