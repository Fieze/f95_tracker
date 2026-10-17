const { extractThreadId, normalizeThreadUrl } = require("./utils");
const { isSafeBrowserUrl } = require("./browserSafety");
const { ApiError } = require("./f95ApiClient");

const text = (value) => typeof value === "string" ? value.trim() : "";
const strings = (value) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
function downloadsOf(value, warnings = []) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group) => {
    const label = text(group?.group) || "Downloads";
    if (/\b(mac|android|linux|ios)\b/i.test(label) && !/\b(win(?:dows)?|pc)\b/i.test(label)) return [];
    const links = (Array.isArray(group?.links) ? group.links : []).flatMap((link) => {
      if (!isSafeBrowserUrl(link?.url)) { warnings.push("An invalid API download URL was ignored."); return []; }
      return [{ label: text(link.label) || text(link.host) || "Download", url: link.url }];
    });
    return links.length ? [{ label, links }] : [];
  });
}
function summaryFingerprint(summary) {
  return JSON.stringify([summary.version, summary.last_promoted, summary.title, summary.developer,
    summary.creator, summary.prefixes, summary.cover, summary.banner, summary.previews, downloadsOf(summary.downloads)]);
}
function adaptApiThread(handiwork, detail, sourceUrl) {
  const id = extractThreadId(sourceUrl);
  if (!handiwork || !detail || String(detail.thread_id) !== id || String(handiwork.id) !== id ||
      !(text(detail.title) || text(handiwork.name)) || !(text(detail.version) || text(handiwork.version))) {
    const error = new ApiError("F95 API returned incomplete required game data.");
    error.incomplete = true;
    throw error;
  }
  let canonical = sourceUrl;
  try { const raw = new URL(detail.url); if (raw.hostname === "f95zone.to" && isSafeBrowserUrl(detail.url)) {
    const candidate = normalizeThreadUrl(detail.url); if (extractThreadId(candidate) === id) canonical = candidate;
  } } catch {}
  const warnings = [];
  const downloads = downloadsOf(detail.downloads?.length ? detail.downloads : handiwork.downloads, warnings);
  if (!downloads.length) warnings.push("API download links are unavailable or not suitable for Windows. Existing links were retained; download approval may be required.");
  const image = [detail.banner, handiwork.banner, detail.cover, handiwork.cover].find(isSafeBrowserUrl) || null;
  const previews = strings(detail.previews?.length ? detail.previews : handiwork.previews).filter(isSafeBrowserUrl);
  const status = text(handiwork.status).toLowerCase();
  const changelog = text(detail.changelog) || (Array.isArray(handiwork.changelog) ? handiwork.changelog.map((entry) =>
    [text(entry.version), ...strings(entry.information)].filter(Boolean).join("\n")).join("\n\n") : "");
  return {
    sourceUrl: canonical, threadId: id, title: text(handiwork.name) || text(detail.title),
    threadTitle: text(detail.title) || text(handiwork.name), currentVersion: text(detail.version) || text(handiwork.version),
    developer: text(detail.developer) || (Array.isArray(handiwork.authors) ? handiwork.authors : []).map((author) => text(author?.name)).filter(Boolean).join(", ") || text(detail.creator),
    engine: text(handiwork.engine), threadStatus: ({ completed: "complete", ongoing: "ongoing", abandoned: "abandoned", onhold: "on hold" })[status] || status,
    overview: text(detail.overview) || text(handiwork.overview), releaseDate: text(detail.release_date) || text(handiwork.last_release),
    changelog, tags: strings(detail.tag_names?.length ? detail.tag_names : handiwork.tags),
    bannerImageUrl: image, screenshotImageUrls: previews, downloadGroups: downloads,
    rawOpHtml: "", rawOpText: "", warnings, dataSource: "api",
    apiLastPromoted: Number.isFinite(detail.last_promoted) ? detail.last_promoted : Number.isFinite(handiwork.last_promoted) ? handiwork.last_promoted : null,
    apiDetailCheckedAt: new Date().toISOString(),
    parserDebug: { dataSource: "api", validationWarnings: warnings }
  };
}
class ThreadDataSource {
  constructor(service) { this.service = service; }
  async load(url, details = {}) {
    const service = this.service;
    if (service.apiKeyStore.key) {
      const id = extractThreadId(url);
      try {
        const handiwork = await service.apiClient.request("/v1/f95/handiwork", { thread_id: id, kind: "game" });
        const detail = await service.apiClient.request(`/v1/threads/${id}`);
        return adaptApiThread(handiwork, detail, url);
      } catch (error) {
        if (!(error.status === 404 || error.incomplete) || !(await service.getAuthState()).loggedIn) throw error;
      }
    }
    if (!(await service.getAuthState()).loggedIn) throw new Error("Please configure an API key or log in to F95Zone first.");
    const thread = await service.fetcher.fetchThread(url);
    const parsed = await service.parseThreadWithLogging(thread.html, thread.url, details);
    return { ...parsed, dataSource: "scraper", parserDebug: { ...parsed.parserDebug, dataSource: "scraper" } };
  }
}
module.exports = { ThreadDataSource, adaptApiThread, downloadsOf, summaryFingerprint };
