import { useEffect, useState } from "react";
import { Markdown } from "../lib/markdown";
import { verificationMarkdown } from "../lib/changelog-verify";
// Bundled at build time: the changelog always documents exactly what this
// installer shipped, with no network access required. @repo-root is aliased to
// the repo root in electron.vite.config.ts (the file sits outside the renderer
// root, so a plain relative import does not resolve).
import changelogRaw from "@repo-root/changelog.md?raw";

/** Full-window changelog viewer for the standalone window (#changelog).
 * Replaces the old nested modal: fixed-position modals rendered inside
 * Settings get trapped by ancestor containing blocks (.set-card:hover applies
 * a transform, .settings-backdrop uses backdrop-filter) — they anchored to
 * the card instead of the viewport, jumped/flickered as hover toggled, and
 * could not be reliably dismissed. A native window has none of that. */
export function StandaloneChangelog() {
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // App-level theme/language normally come from the store; this window has no
    // store bootstrap, so read the config directly.
    window.pi.app
      .getConfig()
      .then((cfg: any) => {
        setLanguage(cfg?.language === "en" ? "en" : "zh");
        const theme = cfg?.theme || "light";
        if (theme !== "system") document.documentElement.dataset.theme = theme;
      })
      .catch(() => {});
    window.pi.app
      .getVersion()
      .then((v: any) => setVersion(typeof v === "string" ? v : null))
      .catch(() => undefined);
  }, []);

  const zh = language === "zh";

  return (
    <div className="changelog-window">
      <div className="changelog-win-head">
        <span className="changelog-win-title">{zh ? "更新日志" : "Changelog"}</span>
        {version && (
          <span className="changelog-version-badge" title={zh ? "当前版本" : "Current version"}>
            v{version}
          </span>
        )}
      </div>
      <div className="changelog-win-sub">
        {zh
          ? "以下为随本安装包内置的更新记录（截至当前版本）；升级后此处会显示更多历史。"
          : "Release notes bundled with this installer (up to the current version); upgrading will show more history here."}
      </div>
      <div className="changelog-win-body">
        <Markdown text={changelogRaw} />
        <div className="changelog-verify-divider" />
        <Markdown text={verificationMarkdown(zh)} />
      </div>
    </div>
  );
}
