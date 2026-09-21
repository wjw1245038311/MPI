import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type {
  McpMarketDetail,
  McpMarketItem,
  McpMarketPage,
  NpmPackage,
  PackageInfo,
  PluginPackage,
  SkillContent,
  SkillHubDetail,
  SkillHubSkill,
  SkillInfo,
} from "../lib/types";
import { Markdown } from "../lib/markdown";
import { AppStore, At, Check, Close, Copy, Files, Gauge, Plug, Plus, Refresh, Search } from "./icons";
import { SidePanel } from "./SidePanel";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

const KIND_LABEL: Record<string, string> = { npm: "npm", git: "git", local: "Local" };

function formatInstalls(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat().format(value);
}

function skillKey(skill: SkillHubSkill): string {
  return `${skill.source}@${skill.skillId}`.toLowerCase();
}

function skillIsInstalled(skill: SkillHubSkill, installed: SkillInfo[], overrides: Set<string>): boolean {
  return overrides.has(skillKey(skill)) || installed.some((item) => item.name.toLowerCase() === skill.skillId.toLowerCase());
}

/** External skill marketplaces linked from the Skill Market tab (open in browser). */
const OTHER_MARKETS = [
  { name: "虾评", domain: "xiaping.coze.com", url: "https://xiaping.coze.com", zhDesc: "精品 Skill 分享评测平台，按场景分类。", enDesc: "Curated skill reviews and rankings, organized by scenario." },
  { name: "SkillHub", domain: "skillhub.cn", url: "https://skillhub.cn", zhDesc: "腾讯维护的 AI Skill 社区，精选 Top 50。", enDesc: "Tencent-run AI skill community with a curated top-50 list." },
  { name: "SkillsMP", domain: "skillsmp.com", url: "https://skillsmp.com", zhDesc: "中文 Agent Skills 市场，支持搜索和分类浏览。", enDesc: "Chinese agent-skill marketplace with search and categories." },
];

/** Human label for a skill root directory (Pi's own dir first, then .agents). */
function rootLabel(root: string, zh: boolean): { label: string; code: string } {
  const norm = root.replace(/\\/g, "/");
  if (norm.endsWith("/.pi/agent/skills")) return { label: zh ? "Pi 目录" : "Pi directory", code: "~/.pi/agent/skills" };
  if (norm.endsWith("/.agents/skills")) return { label: zh ? ".agents 目录" : ".agents directory", code: "~/.agents/skills" };
  return { label: norm, code: root };
}

function SkillsHubPanel({ installedSkills, language }: { installedSkills: SkillInfo[]; language: "en" | "zh" }) {
  const installSkill = useStore((s) => s.installSkill);
  const zh = language === "zh";
  const [query, setQuery] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [results, setResults] = useState<SkillHubSkill[]>([]);
  const [selected, setSelected] = useState<SkillHubSkill | null>(null);
  const [detail, setDetail] = useState<SkillHubDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [installedOverrides, setInstalledOverrides] = useState<Set<string>>(() => new Set());
  const detailRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const items: SkillHubSkill[] = query.trim()
          ? await window.pi.plugins.searchSkillsHub(query.trim())
          : await window.pi.plugins.getSkillsHubLeaderboard();
        if (!cancelled) setResults([...items].sort((a, b) => b.installs - a.installs));
      } catch (e: any) {
        if (!cancelled) {
          setResults([]);
          setError(e?.message || (zh ? "无法加载 skills.sh 目录" : "Unable to load the skills.sh directory"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query.trim() ? 260 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshToken, zh]);

  const selectSkill = async (skill: SkillHubSkill) => {
    const request = ++detailRequest.current;
    setSelected(skill);
    setDetail(null);
    setDetailLoading(true);
    try {
      const payload: SkillHubDetail = await window.pi.plugins.getSkillDetails(skill);
      if (request === detailRequest.current) setDetail(payload);
    } catch (e: any) {
      if (request === detailRequest.current) {
        setDetail({
          ...skill,
          description: e?.message || (zh ? "详情加载失败" : "Unable to load skill details"),
          files: [],
          hash: null,
          installCommand: `npx skills add ${skill.source}@${skill.skillId} --agent pi --global --yes --copy`,
        });
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  const install = async (skill: SkillHubSkill) => {
    const key = skillKey(skill);
    if (installing || skillIsInstalled(skill, installedSkills, installedOverrides)) return;
    setInstalling(key);
    try {
      const ok = await installSkill(skill);
      if (ok) setInstalledOverrides((current) => new Set(current).add(key));
    } finally {
      setInstalling(null);
    }
  };

  const selectedInstalled = selected ? skillIsInstalled(selected, installedSkills, installedOverrides) : false;

  return (
    <div className="skills-hub-body">
      <div className="skills-hub-intro">
        <div>
          <div className="skills-hub-kicker">{zh ? "公开目录" : "PUBLIC DIRECTORY"}</div>
          <div className="skills-hub-copy">
            {zh ? "从 skills.sh 浏览公开技能，默认按下载量排序。" : "Browse public skills from skills.sh, ranked by installs by default."}
          </div>
        </div>
        <a className="skills-hub-link" href="https://skills.sh/" target="_blank" rel="noreferrer noopener">
          skills.sh ↗
        </a>
      </div>

      <div className="skills-other-markets">
        <div className="skills-hub-mini-label">{zh ? "其他市场" : "OTHER MARKETPLACES"}</div>
        <div className="skill-market-grid">
          {OTHER_MARKETS.map((market) => (
            <a key={market.name} className="skill-market-card" href={market.url} target="_blank" rel="noreferrer noopener">
              <div className="skill-market-head">
                <span>{market.name}</span>
                <code>{market.domain}</code>
              </div>
              <p>{zh ? market.zhDesc : market.enDesc}</p>
            </a>
          ))}
        </div>
      </div>

      <div className="skills-hub-toolbar">
        <div className="plugins-search skills-hub-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索公开技能" : "Search public skills"}
            aria-label={zh ? "搜索公开技能" : "Search public skills"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>
        <button
          className="set-iconbtn"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          title={zh ? "刷新 skills.sh 目录" : "Refresh skills.sh directory"}
        >
          {loading ? <span className="spinner" /> : <Refresh size={15} />}
        </button>
      </div>

      {error && <div className="skills-hub-error">{error}</div>}
      <div className="skills-hub-layout">
        <section className="skills-hub-results" aria-label={zh ? "技能搜索结果" : "Skill search results"}>
          <div className="skills-hub-section-head">
            <span>{query.trim() ? (zh ? "搜索结果" : "SEARCH RESULTS") : zh ? "按下载量排序" : "ALL-TIME DOWNLOADS"}</span>
            <span className="skills-hub-count">{loading ? "…" : results.length}</span>
          </div>
          {!loading && results.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的公开技能。" : "No public skills matched your search."}</div>}
          {results.map((skill) => {
            const installed = skillIsInstalled(skill, installedSkills, installedOverrides);
            const active = selected?.id === skill.id;
            const key = skillKey(skill);
            return (
              <div
                className={`skills-hub-card${active ? " active" : ""}`}
                key={skill.id}
                role="button"
                tabIndex={0}
                onClick={() => selectSkill(skill)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSkill(skill);
                  }
                }}
              >
                <div className="skills-hub-card-main">
                  <div className="skills-hub-card-title">
                    <span className="skills-hub-card-name">{skill.name}</span>
                    {installed && <span className="skills-hub-installed-label">{zh ? "已安装" : "Installed"}</span>}
                  </div>
                  <div className="skills-hub-card-source" title={skill.source}>
                    {skill.source}
                  </div>
                  <div className="skills-hub-card-installs">{formatInstalls(skill.installs)} {zh ? "次下载" : "installs"}</div>
                </div>
                <button
                  type="button"
                  className={`skills-hub-install${installed ? " installed" : ""}`}
                  disabled={installed || installing === key}
                  onClick={(event) => {
                    event.stopPropagation();
                    install(skill);
                  }}
                  title={installed ? (zh ? "已安装" : "Installed") : zh ? "安装技能" : "Install skill"}
                  aria-label={installed ? (zh ? `已安装 ${skill.name}` : `${skill.name} installed`) : zh ? `安装 ${skill.name}` : `Install ${skill.name}`}
                >
                  {installing === key ? <span className="spinner" /> : installed ? <Check size={15} /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}

        </section>

        <aside className="skills-hub-detail" aria-label={zh ? "技能详情" : "Skill details"}>
          {!selected && <div className="skills-hub-detail-empty">{zh ? "选择一个技能查看详情" : "Select a skill to view details"}</div>}
          {selected && (
            <>
              <div className="skills-hub-detail-head">
                <div>
                  <div className="skills-hub-detail-title">{selected.name}</div>
                  <div className="skills-hub-card-source">{selected.source}</div>
                </div>
                <button
                  type="button"
                  className={`skills-hub-detail-install${selectedInstalled ? " installed" : ""}`}
                  disabled={selectedInstalled || !!installing}
                  onClick={() => install(selected)}
                >
                  {installing === skillKey(selected) ? <span className="spinner" /> : selectedInstalled ? <Check size={14} /> : <Plus size={14} />}
                  {selectedInstalled ? (zh ? "已安装" : "Installed") : zh ? "安装" : "Install"}
                </button>
              </div>
              <div className="skills-hub-detail-meta">
                <span>{formatInstalls(selected.installs)} {zh ? "次下载" : "installs"}</span>
                <a href={selected.url} target="_blank" rel="noreferrer noopener">
                  {zh ? "查看 skills.sh" : "View on skills.sh"} ↗
                </a>
              </div>
              {detailLoading && <div className="skills-hub-detail-loading"><span className="spinner" /> {zh ? "加载详情…" : "Loading details…"}</div>}
              {detail && !detailLoading && (
                <div className="skills-hub-detail-scroll">
                  <p className="skills-hub-description">{detail.description}</p>
                  <div className="skills-hub-install-command">
                    <div className="skills-hub-mini-label">{zh ? "安装命令" : "INSTALL COMMAND"}</div>
                    <code>{detail.installCommand}</code>
                  </div>
                  {detail.files.length > 0 && (
                    <div className="skills-hub-files">
                      <div className="skills-hub-mini-label">{zh ? "文件" : "FILES"}</div>
                      {detail.files.map((file) => <div key={file.path} className="skills-hub-file">{file.path}</div>)}
                    </div>
                  )}
                  {detail.markdown && (
                    <div className="skills-hub-markdown">
                      <div className="skills-hub-mini-label">SKILL.md</div>
                      <Markdown text={detail.markdown} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

type SkillFilter = "all" | "enabled" | "disabled";

/** Master-detail view for the user's managed skills (left list, right detail). */
function MySkillsView({ skills, loading, language }: { skills: SkillInfo[]; loading: boolean; language: "en" | "zh" }) {
  const toggleSkill = useStore((s) => s.toggleSkill);
  const pushToast = useStore((s) => s.pushToast);
  const zh = language === "zh";

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<SkillContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");
  const contentRequest = useRef(0);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      skills.filter((sk) => {
        if (filter === "enabled" && !sk.enabled) return false;
        if (filter === "disabled" && sk.enabled) return false;
        if (!q) return true;
        return [sk.name, sk.description || "", sk.path].some((value) => value.toLowerCase().includes(q));
      }),
    [skills, filter, q],
  );

  const groups = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    for (const sk of filtered) {
      const list = map.get(sk.root);
      if (list) list.push(sk);
      else map.set(sk.root, [sk]);
    }
    return Array.from(map.entries()).sort((a, b) => {
      const rank = (root: string) => (root.replace(/\\/g, "/").endsWith("/.pi/agent/skills") ? 0 : 1);
      return rank(a[0]) - rank(b[0]);
    });
  }, [filtered]);

  // Keep a valid default selection as the list loads or entries disappear.
  useEffect(() => {
    const stillExists = skills.some((sk) => sk.path === selectedPath);
    if (!stillExists) setSelectedPath(skills.length > 0 ? skills[0].path : null);
  }, [skills, selectedPath]);

  const selected = useMemo(() => skills.find((sk) => sk.path === selectedPath) || null, [skills, selectedPath]);
  const activePath = selected?.path ?? null;

  useEffect(() => {
    if (!activePath) {
      setContent(null);
      setContentError("");
      return;
    }
    const request = ++contentRequest.current;
    setContentLoading(true);
    setContentError("");
    window.pi.plugins
      .getSkillContent(activePath)
      .then((res: SkillContent) => {
        if (request === contentRequest.current) setContent(res);
      })
      .catch((e: any) => {
        if (request === contentRequest.current) setContentError(e?.message || String(e));
      })
      .finally(() => {
        if (request === contentRequest.current) setContentLoading(false);
      });
  }, [activePath]);

  const copyCommand = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(`/skill:${selected.name}`);
      pushToast("success", "命令已复制");
    } catch {
      pushToast("error", "复制失败");
    }
  };

  const copyMarkdown = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.markdown);
      pushToast("success", "Markdown 已复制");
    } catch {
      pushToast("error", "复制失败");
    }
  };

  const counts = useMemo(
    () => ({
      all: skills.length,
      enabled: skills.filter((sk) => sk.enabled).length,
      disabled: skills.filter((sk) => !sk.enabled).length,
    }),
    [skills],
  );

  return (
    <div className="skills-mine">
      <div className="skills-mine-list">
        <div className="plugins-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索我的技能…" : "Search my skills…"}
            aria-label={zh ? "搜索我的技能" : "Search my skills"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>

        <div className="skill-chips">
          {(
            [
              ["all", zh ? "全部" : "All"],
              ["enabled", zh ? "已启用" : "Enabled"],
              ["disabled", zh ? "已禁用" : "Disabled"],
            ] as [SkillFilter, string][]
          ).map(([value, label]) => (
            <button key={value} type="button" className={`skill-chip${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>
              {label} {counts[value]}
            </button>
          ))}
        </div>

        <div className="skills-mine-scroll">
          {loading && skills.length === 0 && <div className="set-empty-mini">{zh ? "加载中…" : "Loading…"}</div>}
          {!loading && skills.length === 0 && (
            <div className="set-empty-mini">
              {zh
                ? "未在 ~/.pi/agent/skills 或 ~/.agents/skills 目录发现独立技能。"
                : "No standalone skills found in ~/.pi/agent/skills or ~/.agents/skills."}
            </div>
          )}
          {skills.length > 0 && filtered.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的技能。" : "No matching skills."}</div>}
          {groups.map(([root, list]) => {
            const rl = rootLabel(root, zh);
            return (
              <div key={root}>
                <div className="skills-group-head">
                  <span>{rl.label}</span>
                  <code title={root}>{rl.code}</code>
                  <span className="count">{list.length}</span>
                </div>
                {list.map((sk) => (
                  <div
                    key={sk.path}
                    role="button"
                    tabIndex={0}
                    className={`skill-row${selectedPath === sk.path ? " active" : ""}`}
                    onClick={() => setSelectedPath(sk.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPath(sk.path);
                      }
                    }}
                  >
                    <span className={`skill-dot ${sk.enabled ? "on" : "off"}`} />
                    <div className="skill-row-main">
                      <div className="skill-row-name">{sk.name}</div>
                      {sk.description && <div className="skill-row-desc">{sk.description}</div>}
                    </div>
                    <span className="skill-row-toggle" onClick={(event) => event.stopPropagation()}>
                      <Toggle checked={sk.enabled} onChange={(v) => toggleSkill(sk.path, v)} />
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="skills-mine-detail" aria-label={zh ? "技能详情" : "Skill details"}>
        {!selected && <div className="set-empty-mini">{zh ? "选择一个技能查看详情" : "Select a skill to view details"}</div>}
        {selected && (
          <>
            <div className="skill-detail-head">
              <div className="skill-detail-title-wrap">
                <div className="skill-detail-title">{selected.name}</div>
                <div className="skill-detail-badges">
                  <span className="plugins-kind">{rootLabel(selected.root, zh).label}</span>
                  <span className={`skill-badge ${selected.enabled ? "on" : "off"}`}>
                    {selected.enabled ? (zh ? "● 已启用" : "● Enabled") : zh ? "已禁用" : "Disabled"}
                  </span>
                </div>
              </div>
              <div className="skill-detail-actions">
                <button type="button" className="set-btn" onClick={copyCommand} title={`/skill:${selected.name}`}>
                  <Copy size={13} /> {zh ? "复制命令" : "Copy command"}
                </button>
                <button
                  type="button"
                  className={`set-btn${selected.enabled ? "" : " primary"}`}
                  onClick={() => toggleSkill(selected.path, !selected.enabled)}
                >
                  {selected.enabled ? (zh ? "停用" : "Disable") : zh ? "启用" : "Enable"}
                </button>
              </div>
            </div>

            <div className="skill-detail-meta">
              <span title={`/skill:${selected.name}`}>
                {zh ? "命令" : "Command"} <code>/skill:{selected.name}</code>
              </span>
              <span className="grow" title={selected.path}>
                {zh ? "路径" : "Path"} <code>{selected.path}</code>
              </span>
            </div>

            {selected.description && (
              <div className="skill-detail-section">
                <div className="skills-hub-mini-label">{zh ? "说明" : "DESCRIPTION"}</div>
                <p className="skills-hub-description">{selected.description}</p>
              </div>
            )}

            <div className="skill-detail-section skill-md-section">
              <div className="skills-hub-mini-label skill-md-head-row">
                SKILL.MD
                {content && !contentLoading && (
                  <button type="button" className="set-btn" onClick={copyMarkdown}>
                    <Copy size={13} /> {zh ? "复制 Markdown" : "Copy Markdown"}
                  </button>
                )}
              </div>
              {contentLoading && (
                <div className="skills-hub-detail-loading">
                  <span className="spinner" /> {zh ? "加载 SKILL.MD…" : "Loading SKILL.md…"}
                </div>
              )}
              {contentError && !contentLoading && <div className="skills-hub-error">{contentError}</div>}
              {content && !contentLoading && (
                <div className="skill-md-body">
                  <Markdown text={content.markdown} />
                </div>
              )}
            </div>

            <div className="muted plugins-note">
              {zh
                ? "停用技能会将其入口文件重命名为 *.disabled（可逆）。"
                : "Disabling a skill renames its entry file to *.disabled (reversible)."}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** Convert a repository URL (git+https / git@host:user/repo) to an https link where possible. */
function repositoryUrl(repo?: string): string | null {
  if (!repo) return null;
  const value = repo.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return null;
}

/** Extension package market: search the public npm registry, install via `npm:<name>`. */
function PackagesMarketView({ language }: { language: "en" | "zh" }) {
  const packages = useStore((s) => s.packages);
  const installPackage = useStore((s) => s.installPackage);
  const zh = language === "zh";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NpmPackage[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [readme, setReadme] = useState("");
  const [loading, setLoading] = useState(true);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const readmeRequest = useRef(0);

  // A dev instance started before this feature has an old preload without these APIs.
  const marketApiReady = typeof window.pi.plugins.searchNpmPackages === "function" && typeof window.pi.plugins.getNpmReadme === "function";

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!marketApiReady) {
        setLoading(false);
        setError(
          zh
            ? "当前实例的 preload 缺少扩展包市场接口——请完全退出 MPI 后重新启动（dev：重新运行 npm run dev）。"
            : "This instance's preload is missing the package-market APIs — fully quit MPI and restart (dev: re-run npm run dev).",
        );
        return;
      }
      setLoading(true);
      setError("");
      try {
        const items: NpmPackage[] = await window.pi.plugins.searchNpmPackages(query.trim());
        if (!cancelled) setResults(items);
      } catch (e: any) {
        if (!cancelled) {
          setResults([]);
          setError(e?.message || (zh ? "无法加载 npm 搜索结果" : "Unable to load npm search results"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query.trim() ? 260 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, zh, marketApiReady]);

  // Keep a valid selection as results change (auto-selects the first hit).
  useEffect(() => {
    const stillExists = results.some((item) => item.name === selectedName);
    if (!stillExists) setSelectedName(results.length > 0 ? results[0].name : null);
  }, [results, selectedName]);

  const selected = useMemo(() => results.find((item) => item.name === selectedName) || null, [results, selectedName]);

  useEffect(() => {
    if (!selected || !marketApiReady) {
      setReadme("");
      return;
    }
    const request = ++readmeRequest.current;
    setReadmeLoading(true);
    window.pi.plugins
      .getNpmReadme(selected.name)
      .then((text: string) => {
        if (request === readmeRequest.current) setReadme(text);
      })
      .catch(() => {
        if (request === readmeRequest.current) setReadme("");
      })
      .finally(() => {
        if (request === readmeRequest.current) setReadmeLoading(false);
      });
  }, [selected, marketApiReady]);

  const isInstalled = (name: string) => packages.some((p) => p.source.toLowerCase() === `npm:${name}`.toLowerCase());

  const install = async (pkg: NpmPackage) => {
    if (installing || isInstalled(pkg.name)) return;
    setInstalling(pkg.name);
    try {
      await installPackage(`npm:${pkg.name}`);
    } finally {
      setInstalling(null);
    }
  };

  const repoLink = repositoryUrl(selected?.repository);

  return (
    <div className="skills-mine">
      <div className="skills-mine-list">
        <div className="plugins-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索 npm 上的扩展包…" : "Search extension packages on npm…"}
            aria-label={zh ? "搜索扩展包" : "Search extension packages"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>

        <div className="npm-market-hint">
          {loading && results.length === 0 ? (
            <>
              <span className="spinner" /> {zh ? "正在搜索 npm…" : "Searching npm…"}
            </>
          ) : query.trim() ? (
            zh ? `找到 ${results.length} 个包 · 按相关度排序` : `${results.length} packages found · ranked by relevance`
          ) : (
            zh ? `默认搜索 “pi extension” · 共 ${results.length} 个结果` : `Default query “pi extension” · ${results.length} results`
          )}
        </div>

        <div className="skills-mine-scroll">
          {error && !loading && <div className="skills-hub-error">{error}</div>}
          {!loading && results.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的扩展包。" : "No matching packages."}</div>}
          {results.map((pkg) => (
            <div
              key={pkg.name}
              role="button"
              tabIndex={0}
              className={`npm-row${selectedName === pkg.name ? " active" : ""}`}
              onClick={() => setSelectedName(pkg.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedName(pkg.name);
                }
              }}
            >
              <div className="skill-row-main">
                <div className="npm-row-name">
                  {pkg.name}
                  {pkg.version && <span className="npm-row-version">v{pkg.version}</span>}
                </div>
                {pkg.description && <div className="skill-row-desc">{pkg.description}</div>}
              </div>
              <span className="npm-row-action" onClick={(event) => event.stopPropagation()}>
                {isInstalled(pkg.name) ? (
                  <span className="skills-hub-installed-label">
                    <Check size={13} /> {zh ? "已安装" : "Installed"}
                  </span>
                ) : (
                  <button type="button" className="set-btn" disabled={installing === pkg.name} onClick={() => install(pkg)} title={`npm:${pkg.name}`}>
                    {installing === pkg.name ? <span className="spinner" /> : <Plus size={13} />} {zh ? "安装" : "Install"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <aside className="skills-mine-detail" aria-label={zh ? "扩展包详情" : "Package details"}>
        {!selected && <div className="set-empty-mini">{zh ? "选择一个扩展包查看详情" : "Select a package to view details"}</div>}
        {selected && (
          <>
            <div className="skill-detail-head">
              <div className="skill-detail-title-wrap">
                <div className="skill-detail-title">{selected.name}</div>
                <div className="skill-detail-badges">
                  {selected.version && <span className="plugins-kind">v{selected.version}</span>}
                  {selected.license && <span className="plugins-kind">{selected.license}</span>}
                  {selected.downloadsWeekly > 0 && (
                    <span className="skill-badge on">
                      {formatInstalls(selected.downloadsWeekly)} {zh ? "周下载" : "/week"}
                    </span>
                  )}
                </div>
              </div>
              <div className="skill-detail-actions">
                {isInstalled(selected.name) ? (
                  <button type="button" className="set-btn" disabled title={zh ? "已在「我的扩展包」中管理" : "Managed under My Packages"}>
                    <Check size={13} /> {zh ? "已安装" : "Installed"}
                  </button>
                ) : (
                  <button type="button" className="set-btn primary" onClick={() => install(selected)} disabled={installing === selected.name} title={`npm:${selected.name}`}>
                    {installing === selected.name ? <span className="spinner" /> : <Plus size={13} />} {zh ? "安装" : "Install"}
                  </button>
                )}
              </div>
            </div>

            <div className="skill-detail-meta">
              <a href={selected.npmUrl} target="_blank" rel="noreferrer noopener">
npm ↗
              </a>
              {repoLink && (
                <a href={repoLink} target="_blank" rel="noreferrer noopener">
                  仓库 ↗
                </a>
              )}
              {selected.date && <span>{zh ? "发布" : "Published"} {new Date(selected.date).toLocaleDateString()}</span>}
            </div>

            {selected.description && (
              <div className="skill-detail-section">
                <div className="skills-hub-mini-label">{zh ? "说明" : "DESCRIPTION"}</div>
                <p className="skills-hub-description">{selected.description}</p>
              </div>
            )}

            {selected.keywords.length > 0 && (
              <div className="skill-detail-section">
                <div className="skills-hub-mini-label">{zh ? "关键词" : "KEYWORDS"}</div>
                <div className="npm-keywords">
                  {selected.keywords.map((keyword) => (
                    <span key={keyword}>{keyword}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="skill-detail-section skill-md-section">
              <div className="skills-hub-mini-label">README</div>
              {readmeLoading && (
                <div className="skills-hub-detail-loading">
                  <span className="spinner" /> {zh ? "加载 README…" : "Loading README…"}
                </div>
              )}
              {!readmeLoading && !readme && <div className="set-empty-mini">{zh ? "该包没有公开的 README。" : "This package has no public README."}</div>}
              {readme && !readmeLoading && (
                <div className="skill-md-body">
                  <Markdown text={readme} />
                </div>
              )}
            </div>

            <div className="muted plugins-note">
              {zh
                ? "安装来源为 npm:<包名>，装好后在「我的扩展包」中更新、停用或移除。"
                : "Installed as npm:<package name>; update, disable or remove it under My Packages."}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** Gate card shown while pi-mcp-market is not installed — MCP module unavailable. */
function McpGateCard({ language }: { language: "en" | "zh" }) {
  const installPackage = useStore((s) => s.installPackage);
  const zh = language === "zh";
  const [installing, setInstalling] = useState(false);

  // A dev instance started before this feature has an old preload without these APIs.
  const mcpApiReady = typeof window.pi.plugins.getMcpServers === "function" && typeof window.pi.plugins.removeMcpServer === "function";

  const installMarket = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await installPackage("npm:pi-mcp-market");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="plugins-body mcp-view">
      {!mcpApiReady && (
        <div className="skills-hub-error">
          {zh
            ? "当前实例的 preload 缺少 MCP 接口——请完全退出 MPI 后重新启动（dev：重新运行 npm run dev）。"
            : "This instance's preload is missing the MCP APIs — fully quit MPI and restart (dev: re-run npm run dev)."}
        </div>
      )}
      <div className="mcp-gate">
        <div className="mcp-gate-icon">
          <Plug size={26} />
        </div>
        <div className="mcp-gate-title">{zh ? "MCP 模块不可用" : "MCP module unavailable"}</div>
        <p className="mcp-gate-copy">
          {zh
            ? "使用 MCP 需要先安装 pi-mcp-market 扩展：它提供 /mcp-market 市场面板，可搜索、预览并安装/卸载 MCP 服务器。实际连接与运行这些服务器还需要 pi-mcp-adapter。"
            : "MCP requires the pi-mcp-market extension: it provides the /mcp-market panel to search, preview and install/uninstall MCP servers. Actually connecting to those servers also needs pi-mcp-adapter."}
        </p>
        <div className="mcp-gate-actions">
          <button type="button" className="set-btn primary" onClick={installMarket} disabled={installing}>
            {installing ? <span className="spinner" /> : <Plus size={14} />}
            {zh ? "安装 pi-mcp-market" : "Install pi-mcp-market"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** My MCP — master-detail over the servers configured in mcp.json (skill-style layout). */
function McpMineView({ language }: { language: "en" | "zh" }) {
  const packages = useStore((s) => s.packages);
  const mcpServers = useStore((s) => s.mcpServers);
  const loading = useStore((s) => s.pluginsLoading);
  const installPackage = useStore((s) => s.installPackage);
  const togglePackage = useStore((s) => s.togglePackage);
  const toggleMcpServer = useStore((s) => s.toggleMcpServer);
  const removeMcpServer = useStore((s) => s.removeMcpServer);
  const pushToast = useStore((s) => s.pushToast);
  const zh = language === "zh";

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "stdio" | "remote">("all");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [installingAdapter, setInstallingAdapter] = useState(false);

  // A dev instance started before this feature has an old preload without these APIs.
  const mcpApiReady = typeof window.pi.plugins.getMcpServers === "function" && typeof window.pi.plugins.removeMcpServer === "function";

  const marketPkg = packages.find((p) => p.name.toLowerCase() === "pi-mcp-market");
  const adapterPkg = packages.find((p) => p.name.toLowerCase() === "pi-mcp-adapter");

  const installAdapter = async () => {
    if (installingAdapter) return;
    setInstallingAdapter(true);
    try {
      await installPackage("npm:pi-mcp-adapter");
    } finally {
      setInstallingAdapter(false);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      mcpServers.filter((server) => {
        if (filter !== "all" && server.transport !== filter) return false;
        if (!q) return true;
        return [server.name, server.command || "", server.url || ""].some((value) => value.toLowerCase().includes(q));
      }),
    [mcpServers, filter, q],
  );

  // Keep a valid default selection as the list loads or entries disappear.
  useEffect(() => {
    const stillExists = mcpServers.some((server) => server.name === selectedName);
    if (!stillExists) setSelectedName(mcpServers.length > 0 ? mcpServers[0].name : null);
  }, [mcpServers, selectedName]);

  const selected = useMemo(() => mcpServers.find((server) => server.name === selectedName) || null, [mcpServers, selectedName]);

  const counts = useMemo(
    () => ({
      all: mcpServers.length,
      stdio: mcpServers.filter((s) => s.transport === "stdio").length,
      remote: mcpServers.filter((s) => s.transport === "remote").length,
    }),
    [mcpServers],
  );

  const copyValue = async (value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      pushToast("success", zh ? "已复制" : "Copied");
    } catch {
      pushToast("error", zh ? "复制失败" : "Copy failed");
    }
  };

  const removeServer = (name: string) => {
    const question = zh
      ? `删除 MCP 服务器 “${name}”？将从 ~/.pi/agent/mcp.json 移除该条目。`
      : `Remove MCP server “${name}”? This deletes its entry from ~/.pi/agent/mcp.json.`;
    if (window.confirm(question)) removeMcpServer(name);
  };

  return (
    <div className="mcp-mine-wrap">
      {!mcpApiReady && (
        <div className="skills-hub-error mcp-deps-warn">
          {zh
            ? "当前实例的 preload 缺少 MCP 接口——请完全退出 MPI 后重新启动（dev：重新运行 npm run dev）。"
            : "This instance's preload is missing the MCP APIs — fully quit MPI and restart (dev: re-run npm run dev)."}
        </div>
      )}

      {/* Dependency strip: pi-mcp-market provides /mcp-market, pi-mcp-adapter runs servers. */}
      <div className="mcp-deps">
        {marketPkg && (
          <div className="mcp-dep-card">
            <span className={`skill-dot ${marketPkg.enabled ? "on" : "off"}`} />
            <span className="mcp-dep-name">pi-mcp-market</span>
            <span className="muted mcp-dep-note">{zh ? "/mcp-market 市场面板" : "/mcp-market panel"}</span>
            <Toggle checked={marketPkg.enabled} onChange={(v) => togglePackage(marketPkg.source, v)} />
          </div>
        )}
        {adapterPkg ? (
          <div className="mcp-dep-card">
            <span className={`skill-dot ${adapterPkg.enabled ? "on" : "off"}`} />
            <span className="mcp-dep-name">pi-mcp-adapter</span>
            <span className="muted mcp-dep-note">{zh ? "连接与运行 MCP 服务器" : "connects to & runs the servers"}</span>
            <Toggle checked={adapterPkg.enabled} onChange={(v) => togglePackage(adapterPkg.source, v)} />
          </div>
        ) : (
          <div className="mcp-dep-card warn">
            <span className="skill-dot off" />
            <span className="mcp-dep-name">pi-mcp-adapter</span>
            <span className="muted mcp-dep-note">{zh ? "未安装——已配置的服务器无法使用" : "not installed — configured servers won't work"}</span>
            <button type="button" className="set-btn primary" onClick={installAdapter} disabled={installingAdapter}>
              {installingAdapter ? <span className="spinner" /> : <Plus size={13} />} {zh ? "安装" : "Install"}
            </button>
          </div>
        )}
      </div>

      <div className="skills-mine mcp-mine-inner">
      <div className="skills-mine-list">
        <div className="plugins-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索我的 MCP 服务器…" : "Search my MCP servers…"}
            aria-label={zh ? "搜索我的 MCP 服务器" : "Search my MCP servers"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>

        <div className="skill-chips">
          {(
            [
              ["all", zh ? "全部" : "All"],
              ["stdio", "stdio"],
              ["remote", "remote"],
            ] as ["all" | "stdio" | "remote", string][]
          ).map(([value, label]) => (
            <button key={value} type="button" className={`skill-chip${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>
              {label} {counts[value]}
            </button>
          ))}
        </div>

        <div className="skills-mine-scroll">
          {loading && mcpServers.length === 0 && <div className="set-empty-mini">{zh ? "加载中…" : "Loading…"}</div>}
          {!loading && mcpServers.length === 0 && (
            <div className="set-empty-mini">
              {zh
                ? "尚未配置任何 MCP 服务器——切到「MCP 市场」浏览，或在会话中运行 /mcp-market。"
                : "No MCP servers configured yet — browse the MCP Market tab, or run /mcp-market in a session."}
            </div>
          )}
          {mcpServers.length > 0 && filtered.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的服务器。" : "No matching servers."}</div>}
          {filtered.map((server) => (
            <div
              key={server.name}
              role="button"
              tabIndex={0}
              className={`skill-row${selectedName === server.name ? " active" : ""}`}
              onClick={() => setSelectedName(server.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedName(server.name);
                }
              }}
            >
              <span className={`skill-dot ${server.disabled ? "off" : "on"}`} />
              <div className="skill-row-main">
                <div className="skill-row-name">{server.name}</div>
                {(server.command || server.url) && <div className="skill-row-desc">{server.command || server.url}</div>}
              </div>
              <span className="plugins-kind skill-row-kind">{server.transport === "stdio" ? "stdio" : "remote"}</span>
              <span className="skill-row-toggle" onClick={(event) => event.stopPropagation()}>
                <Toggle checked={!server.disabled} onChange={(v) => toggleMcpServer(server.name, !v)} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <aside className="skills-mine-detail" aria-label={zh ? "MCP 服务器详情" : "MCP server details"}>
        {!selected && <div className="set-empty-mini">{zh ? "选择一个服务器查看详情" : "Select a server to view details"}</div>}
        {selected && (
          <>
            <div className="skill-detail-head">
              <div className="skill-detail-title-wrap">
                <div className="skill-detail-title">{selected.name}</div>
                <div className="skill-detail-badges">
                  <span className="plugins-kind">{selected.transport === "stdio" ? "stdio" : "remote"}</span>
                  <span className={`skill-badge ${selected.disabled ? "off" : "on"}`}>
                    {selected.disabled ? (zh ? "已禁用" : "Disabled") : zh ? "● 已启用" : "● Enabled"}
                  </span>
                </div>
              </div>
              <div className="skill-detail-actions">
                <button
                  type="button"
                  className={`set-btn${selected.disabled ? "" : " primary"}`}
                  onClick={() => toggleMcpServer(selected.name, !selected.disabled)}
                >
                  {selected.disabled ? (zh ? "启用" : "Enable") : zh ? "停用" : "Disable"}
                </button>
                <button type="button" className="set-iconbtn danger" title={zh ? "删除该服务器" : "Remove this server"} onClick={() => removeServer(selected.name)}>
                  ×
                </button>
              </div>
            </div>

            {(selected.command || selected.url) && (
              <div className="skill-detail-section">
                <div className="skills-hub-mini-label">{selected.transport === "stdio" ? (zh ? "启动命令" : "COMMAND") : zh ? "地址" : "URL"}</div>
                <div className="mcp-cmd-row">
                  <code title={selected.command || selected.url}>{selected.command || selected.url}</code>
                  <button type="button" className="set-btn" onClick={() => copyValue(selected.command || selected.url)}>
                    <Copy size={13} /> {zh ? "复制" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            <div className="skill-detail-section">
              <div className="skills-hub-mini-label">{zh ? "使用" : "USAGE"}</div>
              <p className="skills-hub-description">
                {zh
                  ? "在会话中运行 /mcp-market 可搜索并安装新服务器；/reload 重新加载配置，/mcp 查看连接状态。"
                  : "Run /mcp-market in a session to search and install new servers; /reload re-reads the config, /mcp shows connection status."}
              </p>
            </div>

            <div className="muted plugins-note">
              {zh
                ? "配置读写 ~/.pi/agent/mcp.json（与 pi-mcp-adapter、pi-mcp-market 共享）；停用只写 disabled 标志，可随时恢复。"
                : "Config is read from and written to ~/.pi/agent/mcp.json (shared with pi-mcp-adapter and pi-mcp-market); disabling only sets a flag and is reversible."}
            </div>
          </>
        )}
      </aside>
      </div>
    </div>
  );
}

/** Absolute URL for an mcpmarket.cn logo (list API returns site-relative paths). */
function mcpLogoUrl(logo?: string): string | undefined {
  if (!logo) return undefined;
  if (/^https?:\/\//.test(logo)) return logo;
  return `https://mcpmarket.cn${logo.startsWith("/") ? "" : "/"}${logo}`;
}

/** MCP Market — browse the public mcpmarket.cn directory (skill-market-style layout). */
function McpMarketView({ language }: { language: "en" | "zh" }) {
  const zh = language === "zh";

  const [query, setQuery] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [items, setItems] = useState<McpMarketItem[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<McpMarketItem | null>(null);
  const [detail, setDetail] = useState<McpMarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const result: McpMarketPage = await window.pi.plugins.searchMcpMarket(query.trim(), 1);
        if (!cancelled) {
          setItems(result.items);
          setPage(result.page);
          setPages(result.pages);
          setTotal(result.total);
        }
      } catch (e: any) {
        if (!cancelled) {
          setItems([]);
          setError(e?.message || (zh ? "无法加载 mcpmarket.cn 目录" : "Unable to load the mcpmarket.cn directory"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query.trim() ? 260 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshToken, zh]);

  const loadMore = async () => {
    if (loading || loadingMore || page >= pages) return;
    setLoadingMore(true);
    try {
      const result: McpMarketPage = await window.pi.plugins.searchMcpMarket(query.trim(), page + 1);
      setItems((current) => [...current, ...result.items]);
      setPage(result.page);
      setPages(result.pages);
    } catch (e: any) {
      setError(e?.message || (zh ? "加载失败" : "Load failed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const selectItem = async (item: McpMarketItem) => {
    const request = ++detailRequest.current;
    setSelected(item);
    setDetail(null);
    setDetailLoading(true);
    try {
      const payload: McpMarketDetail = await window.pi.plugins.getMcpMarketDetail(item.id);
      if (request === detailRequest.current) setDetail(payload);
    } catch {
      // Detail fetch failed — the list-level info below still renders.
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  const descText = selected ? (detail ? (zh ? detail.descriptionZh || detail.descriptionEn : detail.descriptionEn || detail.descriptionZh) : selected.description) : undefined;
  const overview = detail ? (zh ? detail.overviewZh || detail.overviewEn : detail.overviewEn || detail.overviewZh) : undefined;

  return (
    <div className="skills-hub-body">
      <div className="skills-hub-intro">
        <div>
          <div className="skills-hub-kicker">{zh ? "公开目录" : "PUBLIC DIRECTORY"}</div>
          <div className="skills-hub-copy">
            {zh ? `浏览 mcpmarket.cn 的 MCP 服务器目录（共 ${total || "…"} 个），支持搜索。` : `Browse the MCP server directory on mcpmarket.cn (${total || "…"} entries), with search.`}
          </div>
        </div>
        <a className="skills-hub-link" href="https://mcpmarket.cn/" target="_blank" rel="noreferrer noopener">
          mcpmarket.cn ↗
        </a>
      </div>

      <div className="skills-hub-toolbar">
        <div className="plugins-search skills-hub-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? "搜索 MCP 服务器" : "Search MCP servers"}
            aria-label={zh ? "搜索 MCP 服务器" : "Search MCP servers"}
          />
          {query && (
            <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
              ×
            </button>
          )}
        </div>
        <button
          className="set-iconbtn"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          title={zh ? "刷新 mcpmarket.cn 目录" : "Refresh the mcpmarket.cn directory"}
        >
          {loading ? <span className="spinner" /> : <Refresh size={15} />}
        </button>
      </div>

      {error && <div className="skills-hub-error">{error}</div>}
      <div className="skills-hub-layout">
        <section className="skills-hub-results" aria-label={zh ? "MCP 服务器搜索结果" : "MCP server search results"}>
          <div className="skills-hub-section-head">
            <span>{query.trim() ? (zh ? "搜索结果" : "SEARCH RESULTS") : zh ? "全部目录" : "ALL ENTRIES"}</span>
            <span className="skills-hub-count">{loading ? "…" : items.length}</span>
          </div>
          {!loading && !error && items.length === 0 && (
            <div className="set-empty-mini">{zh ? "没有匹配的 MCP 服务器。" : "No MCP servers matched your search."}</div>
          )}
          {items.map((item) => {
            const active = selected?.id === item.id;
            const logo = mcpLogoUrl(item.logo);
            return (
              <div
                className={`skills-hub-card${active ? " active" : ""}`}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => selectItem(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectItem(item);
                  }
                }}
              >
                <div className="mcp-market-logo-wrap">
                  {logo ? (
                    <img className="mcp-market-logo" src={logo} alt="" loading="lazy" onError={(event) => ((event.target as HTMLImageElement).style.display = "none")} />
                  ) : (
                    <span className="mcp-market-logo-fallback">{item.name.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="skills-hub-card-main">
                  <div className="skills-hub-card-title">
                    <span className="skills-hub-card-name">{item.name}</span>
                    {item.featured && <span className="skills-hub-installed-label">{zh ? "精选" : "Featured"}</span>}
                  </div>
                  {item.by && (
                    <div className="skills-hub-card-source">
                      @{item.by}
                      {typeof item.stars === "number" && item.stars > 0 && ` · ${formatInstalls(item.stars)} ★`}
                    </div>
                  )}
                  {item.description && <div className="mcp-market-desc">{item.description}</div>}
                </div>
              </div>
            );
          })}
          {!loading && !error && page < pages && (
            <button type="button" className="set-btn mcp-load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <span className="spinner" /> : null} {zh ? `加载更多（第 ${page}/${pages} 页）` : `Load more (page ${page}/${pages})`}
            </button>
          )}
        </section>

        <aside className="skills-hub-detail" aria-label={zh ? "MCP 服务器详情" : "MCP server details"}>
          {!selected && <div className="skills-hub-detail-empty">{zh ? "选择一个 MCP 服务器查看详情" : "Select an MCP server to view details"}</div>}
          {selected && (
            <>
              <div className="skills-hub-detail-head">
                <div className="mcp-market-logo-wrap big">
                  {(() => {
                    const logo = mcpLogoUrl(detail?.logo || selected.logo);
                    return logo ? (
                      <img className="mcp-market-logo" src={logo} alt="" onError={(event) => ((event.target as HTMLImageElement).style.display = "none")} />
                    ) : (
                      <span className="mcp-market-logo-fallback">{selected.name.slice(0, 1).toUpperCase()}</span>
                    );
                  })()}
                </div>
                <div className="skills-hub-detail-head-main">
                  <div className="skills-hub-detail-title">{selected.name}</div>
                  {selected.by && <div className="skills-hub-card-source">@{selected.by}</div>}
                </div>
              </div>

              {(detail?.mcpType || detail?.categories) && (
                <div className="skill-detail-badges mcp-market-badges">
                  {detail?.mcpType?.map((type) => (
                    <span key={type} className="plugins-kind">
                      {type}
                    </span>
                  ))}
                  {detail?.categories?.slice(0, 4).map((category) => (
                    <span key={category} className="skill-badge on">
                      {category}
                    </span>
                  ))}
                </div>
              )}

              <div className="skills-hub-detail-meta">
                {typeof selected.stars === "number" && selected.stars > 0 && (
                  <span title={zh ? "GitHub Stars" : "GitHub stars"}>{formatInstalls(selected.stars)} ★</span>
                )}
                {selected.url && (
                  <a href={selected.url} target="_blank" rel="noreferrer noopener">
                    GitHub ↗
                  </a>
                )}
                <a href="https://mcpmarket.cn/" target="_blank" rel="noreferrer noopener">
                  {zh ? "在 mcpmarket.cn 查看" : "View on mcpmarket.cn"} ↗
                </a>
              </div>

              {detailLoading && (
                <div className="skills-hub-detail-loading">
                  <span className="spinner" /> {zh ? "加载详情…" : "Loading details…"}
                </div>
              )}

              {!detailLoading && descText && <p className="skills-hub-description">{descText}</p>}

              {!detailLoading && overview && (
                <div className="skills-hub-detail-scroll">
                  {overview.what_is && (
                    <div className="skill-detail-section">
                      <div className="skills-hub-mini-label">{zh ? "简介" : "WHAT IS IT"}</div>
                      <p className="skills-hub-description">{overview.what_is}</p>
                    </div>
                  )}
                  {overview.key_features && (
                    <div className="skill-detail-section">
                      <div className="skills-hub-mini-label">{zh ? "核心特性" : "KEY FEATURES"}</div>
                      <p className="skills-hub-description">{overview.key_features}</p>
                    </div>
                  )}
                  {overview.how_to_use && (
                    <div className="skill-detail-section">
                      <div className="skills-hub-mini-label">{zh ? "如何使用" : "HOW TO USE"}</div>
                      <p className="skills-hub-description">{overview.how_to_use}</p>
                    </div>
                  )}
                  {overview.use_cases && (
                    <div className="skill-detail-section">
                      <div className="skills-hub-mini-label">{zh ? "使用场景" : "USE CASES"}</div>
                      <p className="skills-hub-description">{overview.use_cases}</p>
                    </div>
                  )}
                </div>
              )}

              {!detailLoading && !descText && !overview && (
                <div className="muted plugins-note">
                  {zh ? "该条目暂无更多介绍——可打开 GitHub 链接查看。" : "No further details for this entry — open the GitHub link to learn more."}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Phase-1 inventory stats: totals, per-root distribution, disabled list. */
function SkillStatsView({ skills, language }: { skills: SkillInfo[]; language: "en" | "zh" }) {
  const toggleSkill = useStore((s) => s.toggleSkill);
  const zh = language === "zh";

  const total = skills.length;
  const enabledCount = skills.filter((sk) => sk.enabled).length;
  const disabledList = useMemo(() => skills.filter((sk) => !sk.enabled), [skills]);

  const groups = useMemo(() => {
    const map = new Map<string, number>();
    for (const sk of skills) map.set(sk.root, (map.get(sk.root) || 0) + 1);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [skills]);

  if (total === 0) {
    return (
      <div className="plugins-body">
        <div className="set-empty-mini">{zh ? "暂无技能数据。" : "No skill data yet."}</div>
      </div>
    );
  }

  return (
    <div className="plugins-body">
      <div className="stats-cards">
        <div className="stat-card">
          <span>{zh ? "技能总数" : "Total skills"}</span>
          <strong>{total}</strong>
        </div>
        <div className="stat-card ok">
          <span>{zh ? "已启用" : "Enabled"}</span>
          <strong>{enabledCount}</strong>
        </div>
        <div className="stat-card off">
          <span>{zh ? "已禁用" : "Disabled"}</span>
          <strong>{disabledList.length}</strong>
        </div>
      </div>

      <section className="plugins-section">
        <div className="plugins-section-head">{zh ? "按来源目录分布" : "By source directory"}</div>
        {groups.map(([root, count]) => {
          const rl = rootLabel(root, zh);
          const pct = Math.round((count / total) * 100);
          return (
            <div key={root} className="stat-bar-row">
              <span className="stat-bar-label" title={root}>
                {rl.label}
              </span>
              <div className="stat-bar">
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="stat-bar-count">
                {count}（{pct}%）
              </span>
            </div>
          );
        })}
      </section>

      {disabledList.length > 0 && (
        <section className="plugins-section">
          <div className="plugins-section-head">{zh ? "已禁用的技能" : "Disabled skills"}</div>
          {disabledList.map((sk) => (
            <div key={sk.path} className="plugins-row">
              <div className="plugins-row-main">
                <span className="skill-dot off" />
                <span className="plugins-row-name">{sk.name}</span>
              </div>
              <div className="plugins-row-sub" title={sk.path}>
                {sk.path}
              </div>
              <div className="plugins-row-actions">
                <Toggle checked={false} onChange={() => toggleSkill(sk.path, true)} />
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** Fixed group order for the package list (npm first, then git, local). */
const KIND_ORDER: Record<string, number> = { npm: 0, git: 1, local: 2 };

function kindLabel(kind: string, zh: boolean): string {
  return kind === "local" ? (zh ? "本地" : "Local") : KIND_LABEL[kind] || kind;
}

/** Extension package management — master-detail layout mirroring My Skills. */
function PackagesView({ language, onOpenMarket }: { language: "en" | "zh"; onOpenMarket: () => void }) {
  const packages = useStore((s) => s.packages);
  const loading = useStore((s) => s.pluginsLoading);
  const togglePackage = useStore((s) => s.togglePackage);
  const installPackage = useStore((s) => s.installPackage);
  const removePackage = useStore((s) => s.removePackage);
  const updatePackages = useStore((s) => s.updatePackages);
  const zh = language === "zh";

  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updatingOne, setUpdatingOne] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [info, setInfo] = useState<PackageInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const infoRequest = useRef(0);
  // Packages have no marketplace — sources are found manually (npm/GitHub),
  // so the install form stays collapsed behind a small button by default.
  const [installOpen, setInstallOpen] = useState(false);
  const installInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (installOpen) installInputRef.current?.focus();
  }, [installOpen]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      packages.filter((p) => {
        if (filter === "enabled" && !p.enabled) return false;
        if (filter === "disabled" && p.enabled) return false;
        if (!q) return true;
        return [p.name, p.source, p.kind].some((value) => value.toLowerCase().includes(q));
      }),
    [packages, filter, q],
  );

  const groups = useMemo(() => {
    const map = new Map<string, PluginPackage[]>();
    for (const p of filtered) {
      const list = map.get(p.kind);
      if (list) list.push(p);
      else map.set(p.kind, [p]);
    }
    return Array.from(map.entries()).sort((a, b) => (KIND_ORDER[a[0]] ?? 9) - (KIND_ORDER[b[0]] ?? 9));
  }, [filtered]);

  // Keep a valid default selection as the list loads or entries disappear.
  useEffect(() => {
    const stillExists = packages.some((p) => p.source === selectedSource);
    if (!stillExists) setSelectedSource(packages.length > 0 ? packages[0].source : null);
  }, [packages, selectedSource]);

  const selected = useMemo(() => packages.find((p) => p.source === selectedSource) || null, [packages, selectedSource]);
  const activeSource = selected?.source ?? null;

  useEffect(() => {
    if (!activeSource) {
      setInfo(null);
      return;
    }
    const request = ++infoRequest.current;
    setInfoLoading(true);
    window.pi.plugins
      .getPackageInfo(activeSource)
      .then((res: PackageInfo) => {
        if (request === infoRequest.current) setInfo(res);
      })
      .catch(() => {
        if (request === infoRequest.current) setInfo(null);
      })
      .finally(() => {
        if (request === infoRequest.current) setInfoLoading(false);
      });
  }, [activeSource]);

  const counts = useMemo(
    () => ({
      all: packages.length,
      enabled: packages.filter((p) => p.enabled).length,
      disabled: packages.filter((p) => !p.enabled).length,
    }),
    [packages],
  );

  const install = async () => {
    const s = source.trim();
    if (!s) return;
    setBusy(true);
    await installPackage(s);
    setBusy(false);
    setSource("");
    setInstallOpen(false);
  };

  const updating = updatingAll || updatingOne !== null;
  const updateAll = async () => {
    if (updating) return;
    setUpdatingAll(true);
    await updatePackages();
    setUpdatingAll(false);
  };
  const updateOne = async (src: string) => {
    if (updating) return;
    setUpdatingOne(src);
    await updatePackages(src);
    setUpdatingOne(null);
  };

  const removeSelected = () => {
    if (!selected) return;
    const question = zh ? `移除包 “${selected.name}”？将执行 pi remove 卸载。` : `Remove package “${selected.name}”? This runs pi remove.`;
    if (window.confirm(question)) removePackage(selected.source);
  };

  return (
    <div className="packages-view">
      <div className="packages-install-row">
        <button
          type="button"
          className="set-btn"
          onClick={() => setInstallOpen((v) => !v)}
          title={zh ? "粘贴安装来源（npm / git / 本地路径）" : "Paste a package source (npm / git / local path)"}
        >
          {installOpen ? <Close size={13} /> : <Plus size={14} />} {zh ? "安装扩展包" : "Install package"}
        </button>
        <button
          className="set-btn packages-update-all"
          onClick={updateAll}
          disabled={updating || packages.length === 0}
          title={zh ? "检查并更新所有扩展（pi update --extensions）" : "Check and update all extensions (pi update --extensions)"}
        >
          {updatingAll ? <span className="spinner" /> : <Refresh size={13} />}
          {zh ? "更新全部" : "Update all"}
        </button>
      </div>

      {installOpen && (
        <div className="packages-install-form">
          <div className="packages-install-line">
            <input
              ref={installInputRef}
              className="set-input"
              placeholder={zh ? "安装来源，如 npm:@foo/bar、git:github.com/user/repo 或本地路径" : "Package source, such as npm:@foo/bar, git:github.com/user/repo, or a local path"}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") install();
                else if (e.key === "Escape") setInstallOpen(false);
              }}
            />
            <button className="set-btn primary" onClick={install} disabled={busy || !source.trim()}>
              {busy ? <span className="spinner" /> : <Plus size={14} />} {zh ? "安装" : "Install"}
            </button>
          </div>
          <div className="packages-install-hint">
            {zh ? "也可以到" : "Or browse from the "}
            <button type="button" className="skills-hub-link" onClick={onOpenMarket}>
              {zh ? "「扩展包市场」子页 →" : "Package Market sub-tab →"}
            </button>
          </div>
        </div>
      )}

      <div className="skills-mine packages-body">
        <div className="skills-mine-list">
          <div className="plugins-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? "搜索扩展包" : "Search packages"}
              aria-label={zh ? "搜索扩展包" : "Search packages"}
            />
            {query && (
              <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label={zh ? "清除搜索" : "Clear search"}>
                ×
              </button>
            )}
          </div>

          <div className="skill-chips">
            {(
              [
                ["all", zh ? "全部" : "All"],
                ["enabled", zh ? "已启用" : "Enabled"],
                ["disabled", zh ? "已禁用" : "Disabled"],
              ] as [SkillFilter, string][]
            ).map(([value, label]) => (
              <button key={value} type="button" className={`skill-chip${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>
                {label} {counts[value]}
              </button>
            ))}
          </div>

          <div className="skills-mine-scroll">
            {loading && packages.length === 0 && <div className="set-empty-mini">{zh ? "加载中…" : "Loading…"}</div>}
            {!loading && packages.length === 0 && (
              <div className="set-empty-mini">{zh ? "尚未安装任何扩展包。" : "No extension packages installed."}</div>
            )}
            {packages.length > 0 && filtered.length === 0 && <div className="set-empty-mini">{zh ? "没有匹配的扩展包。" : "No matching extension packages."}</div>}
            {groups.map(([kind, list]) => (
              <div key={kind}>
                <div className="skills-group-head">
                  <span>{kindLabel(kind, zh)}</span>
                  <span className="count">{list.length}</span>
                </div>
                {list.map((p) => (
                  <div
                    key={p.source}
                    role="button"
                    tabIndex={0}
                    className={`skill-row${selectedSource === p.source ? " active" : ""}`}
                    onClick={() => setSelectedSource(p.source)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedSource(p.source);
                      }
                    }}
                  >
                    <span className={`skill-dot ${p.enabled ? "on" : "off"}`} />
                    <div className="skill-row-main">
                      <div className="skill-row-name">{p.name}</div>
                      <div className="skill-row-desc" title={p.source}>
                        {p.source}
                      </div>
                    </div>
                    <span className="skill-row-toggle" onClick={(event) => event.stopPropagation()}>
                      <Toggle checked={p.enabled} onChange={(v) => togglePackage(p.source, v)} />
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <aside className="skills-mine-detail" aria-label={zh ? "扩展包详情" : "Package details"}>
          {!selected && <div className="set-empty-mini">{zh ? "选择一个扩展包查看详情" : "Select a package to view details"}</div>}
          {selected && (
            <>
              <div className="skill-detail-head">
                <div className="skill-detail-title-wrap">
                  <div className="skill-detail-title">{selected.name}</div>
                  <div className="skill-detail-badges">
                    <span className="plugins-kind">{kindLabel(selected.kind, zh)}</span>
                    {info?.version && <span className="plugins-kind">v{info.version}</span>}
                    <span className={`skill-badge ${selected.enabled ? "on" : "off"}`}>
                      {selected.enabled ? (zh ? "● 已启用" : "● Enabled") : zh ? "已禁用" : "Disabled"}
                    </span>
                  </div>
                </div>
                <div className="skill-detail-actions">
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() => updateOne(selected.source)}
                    disabled={updating}
                    title={zh ? "检查并更新此扩展" : "Check and update this extension"}
                  >
                    {updatingOne === selected.source ? <span className="spinner" /> : <Refresh size={13} />} {zh ? "更新" : "Update"}
                  </button>
                  <button
                    type="button"
                    className={`set-btn${selected.enabled ? "" : " primary"}`}
                    onClick={() => togglePackage(selected.source, !selected.enabled)}
                  >
                    {selected.enabled ? (zh ? "停用" : "Disable") : zh ? "启用" : "Enable"}
                  </button>
                  <button type="button" className="set-iconbtn danger" title={zh ? "移除（执行 pi remove）" : "Remove (runs pi remove)"} onClick={removeSelected}>
                    ×
                  </button>
                </div>
              </div>

              <div className="skill-detail-meta">
                <span className="grow" title={selected.source}>
                  {zh ? "来源" : "Source"} <code>{selected.source}</code>
                </span>
                {info?.dir && (
                  <span className="grow" title={info.dir}>
                    {zh ? "安装目录" : "Location"} <code>{info.dir}</code>
                  </span>
                )}
              </div>

              {infoLoading && (
                <div className="skills-hub-detail-loading">
                  <span className="spinner" /> {zh ? "读取包信息…" : "Reading package info…"}
                </div>
              )}

              {info?.description && !infoLoading && (
                <div className="skill-detail-section">
                  <div className="skills-hub-mini-label">{zh ? "说明" : "DESCRIPTION"}</div>
                  <p className="skills-hub-description">{info.description}</p>
                </div>
              )}

              <div className="muted plugins-note">
                {zh
                  ? "开关写入 ~/.pi/agent/settings.json（autoload），与终端 pi 共享；移除会执行 pi remove 卸载。"
                  : "Toggling writes autoload into ~/.pi/agent/settings.json, shared with terminal Pi. Removing runs `pi remove` to uninstall."}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export function PluginsPanel() {
  const open = useStore((s) => s.pluginsOpen);
  const close = useStore((s) => s.closePlugins);
  const packagesCount = useStore((s) => s.packages.length);
  // The MCP module is gated on pi-mcp-market being installed.
  const mcpAvailable = useStore((s) => s.packages.some((p) => p.name.toLowerCase() === "pi-mcp-market"));
  const skills = useStore((s) => s.skills);
  const loading = useStore((s) => s.pluginsLoading);
  const loadPlugins = useStore((s) => s.loadPlugins);
  const language = useStore((s) => s.config?.language || "en");
  const zh = language === "zh";

  const mcpCount = useStore((s) => s.mcpServers.length);

  const [module, setModule] = useState<"skills" | "packages" | "mcp">("skills");
  const [skillTab, setSkillTab] = useState<"mine" | "market" | "stats">("mine");
  const [packageTab, setPackageTab] = useState<"mine" | "market">("mine");
  const [mcpTab, setMcpTab] = useState<"mine" | "market">("mine");

  if (!open) return null;

  return (
    <SidePanel title={zh ? "扩展功能" : "Extensions"} icon={<At size={15} />} onClose={close}>
      <div className="plugins-tabs-row">
          <div className="plugins-module-tabs" role="tablist" aria-label={zh ? "扩展功能模块" : "Extension modules"}>
            <button type="button" role="tab" aria-selected={module === "skills"} className={`plugin-tab${module === "skills" ? " active" : ""}`} onClick={() => setModule("skills")}>
              {zh ? "技能" : "Skills"} <span className="tabs-count">{skills.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={module === "packages"} className={`plugin-tab${module === "packages" ? " active" : ""}`} onClick={() => setModule("packages")}>
              {zh ? "扩展包" : "Packages"} <span className="tabs-count">{packagesCount}</span>
            </button>
            <button type="button" role="tab" aria-selected={module === "mcp"} className={`plugin-tab${module === "mcp" ? " active" : ""}`} onClick={() => setModule("mcp")}>
              MCP <span className="tabs-count">{mcpCount}</span>
            </button>
          </div>

          {module === "skills" && (
            <div className="skills-subtabs">
              <button type="button" className={`skill-subtab${skillTab === "mine" ? " active" : ""}`} onClick={() => setSkillTab("mine")}>
                <Files size={13} /> {zh ? "我的技能" : "My Skills"}
              </button>
              <button type="button" className={`skill-subtab${skillTab === "market" ? " active" : ""}`} onClick={() => setSkillTab("market")}>
                <AppStore size={13} /> {zh ? "Skill 市场" : "Skill Market"}
              </button>
              <button type="button" className={`skill-subtab${skillTab === "stats" ? " active" : ""}`} onClick={() => setSkillTab("stats")}>
                <Gauge size={13} /> {zh ? "统计" : "Stats"}
              </button>
            </div>
          )}

          {module === "packages" && (
            <div className="skills-subtabs">
              <button type="button" className={`skill-subtab${packageTab === "mine" ? " active" : ""}`} onClick={() => setPackageTab("mine")}>
                <Files size={13} /> {zh ? "我的扩展包" : "My Packages"}
              </button>
              <button type="button" className={`skill-subtab${packageTab === "market" ? " active" : ""}`} onClick={() => setPackageTab("market")}>
                <AppStore size={13} /> {zh ? "扩展包市场" : "Package Market"}
              </button>
            </div>
          )}

          {module === "mcp" && mcpAvailable && (
            <div className="skills-subtabs">
              <button type="button" className={`skill-subtab${mcpTab === "mine" ? " active" : ""}`} onClick={() => setMcpTab("mine")}>
                <Files size={13} /> {zh ? "我的 MCP" : "My MCP"}
              </button>
              <button type="button" className={`skill-subtab${mcpTab === "market" ? " active" : ""}`} onClick={() => setMcpTab("market")}>
                <AppStore size={13} /> {zh ? "MCP 市场" : "MCP Market"}
              </button>
            </div>
          )}

          <button className="set-iconbtn plugins-refresh" onClick={() => loadPlugins()} disabled={loading} title={zh ? "刷新扩展功能和技能" : "Refresh extensions and skills"}>
            {loading ? <span className="spinner" /> : <Refresh size={15} />}
          </button>
        </div>

        <div className="plugins-content">
          {module === "mcp" ? (
            mcpAvailable ? (
              mcpTab === "mine" ? (
                <McpMineView language={language} />
              ) : (
                <McpMarketView language={language} />
              )
            ) : (
              <McpGateCard language={language} />
            )
          ) : module === "packages" ? (
            packageTab === "mine" ? (
              <PackagesView language={language} onOpenMarket={() => setPackageTab("market")} />
            ) : (
              <PackagesMarketView language={language} />
            )
          ) : skillTab === "mine" ? (
            <MySkillsView skills={skills} loading={loading} language={language} />
          ) : skillTab === "market" ? (
            <SkillsHubPanel installedSkills={skills} language={language} />
          ) : (
            <SkillStatsView skills={skills} language={language} />
          )}
        </div>
    </SidePanel>
  );
}
