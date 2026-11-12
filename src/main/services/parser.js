const cheerio = require("cheerio");
const { sanitizeVersion } = require("./utils");
const { branchDisplayLabel, expandBranches, parseBranch, parsePlatform, parseVariant } = require("./releaseNames");

const VERSION_PATTERNS = [
  /\[([^\]]*?(?:v(?:ersion)?\.?\s*[0-9][^\]]*))\]/i,
  /\bversion[:\s]*([0-9][0-9a-z._-]*)/i,
  /\bv(?:ersion)?\.?\s*([0-9][0-9a-z._-]*)/i
];

const FIELD_HEADER_PATTERNS = {
  developer: /^(developer|artist)\s*:?\s*(.*)$/i,
  engine: /^(engine)\s*:?\s*(.*)$/i,
  version: /^(version)\s*:?\s*(.*)$/i,
  overview: /^(overview|story|synopsis)\s*:?\s*(.*)$/i,
  releaseDate: /^(release\s+date)\s*:?\s*(.*)$/i,
  changelog: /^(change-?log|release notes)\s*:?\s*(.*)$/i
};

const THREAD_STATUS_LABELS = new Map([
  ["onhold", "On Hold"],
  ["on hold", "On Hold"],
  ["abandoned", "Abandoned"],
  ["complete", "Complete"],
  ["completed", "Complete"]
]);

// Engine prefixes as shown on F95Zone; the label text is the reliable signal, CSS classes differ per engine.
const ENGINE_PREFIXES = new Map([
  ["ren'py", "Ren'Py"],
  ["renpy", "Ren'Py"],
  ["rpgm", "RPGM"],
  ["unity", "Unity"],
  ["unreal engine", "Unreal Engine"],
  ["html", "HTML"],
  ["java", "Java"],
  ["flash", "Flash"],
  ["qsp", "QSP"],
  ["rags", "RAGS"],
  ["tads", "TADS"],
  ["adrift", "ADRIFT"],
  ["webgl", "WebGL"],
  ["wolf rpg", "Wolf RPG"],
  ["godot", "Godot"]
]);

const CHANGELOG_LABEL_PATTERN = /change-?log|release notes/i;
const MAX_CHANGELOG_LENGTH = 20000;

function textOf(node) {
  return String(node.text() || "").replace(/\s+/g, " ").trim();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isTitlePrefixNode($, node) {
  const wrapped = $(node);
  const className = String(wrapped.attr("class") || "").toLowerCase();
  if (wrapped.hasClass("label-append")) {
    return true;
  }

  if (
    wrapped.hasClass("labelLink") ||
    /\blabel\b/.test(className) ||
    /\bpre-/.test(className)
  ) {
    return true;
  }

  return wrapped.find(".label, [class^='pre-'], [class*=' pre-']").length > 0;
}

function extractDisplayTitleText($, titleNode) {
  if (!titleNode?.length) {
    return "";
  }

  const parts = [];
  let seenNonPrefixContent = false;

  titleNode.contents().each((_, node) => {
    if (node.type === "text") {
      const text = normalizeWhitespace($(node).text());
      if (text) {
        seenNonPrefixContent = true;
        parts.push(text);
      }
      return;
    }

    if (node.type !== "tag") {
      return;
    }

    if (!seenNonPrefixContent && isTitlePrefixNode($, node)) {
      return;
    }

    const text = normalizeWhitespace($(node).text());
    if (text) {
      seenNonPrefixContent = true;
      parts.push(text);
    }
  });

  return normalizeWhitespace(parts.join(" "));
}

function extractThreadStatus($, titleNode) {
  if (!titleNode?.length) {
    return null;
  }

  const prefixTexts = [];
  titleNode.contents().each((_, node) => {
    if (node.type !== "tag") {
      return;
    }

    if (!isTitlePrefixNode($, node)) {
      return;
    }

    const text = normalizeWhitespace($(node).text());
    if (text) {
      prefixTexts.push(text);
    }
  });

  for (const prefixText of prefixTexts) {
    const normalized = prefixText.toLowerCase();
    if (THREAD_STATUS_LABELS.has(normalized)) {
      return THREAD_STATUS_LABELS.get(normalized);
    }
  }

  return null;
}

function extractTitlePrefixes($, titleNode) {
  const prefixes = [];
  titleNode?.find(".labelLink").each((_, node) => {
    const text = normalizeWhitespace($(node).text());
    if (text) prefixes.push(text);
  });
  return prefixes;
}

function extractEngineFromPrefixes(prefixes) {
  for (const prefix of prefixes) {
    const engine = ENGINE_PREFIXES.get(prefix.toLowerCase());
    if (engine) return engine;
  }
  return null;
}

// Text right before a spoiler block (skipping blank text and <br>), used to find the "Changelog:" label.
// The label and its colon are often separate nodes ("<b>Changelog</b>:"), so the nearest few pieces are joined.
function labelBeforeSpoiler($, spoilerNode) {
  const pieces = [];
  let node = spoilerNode;
  for (let depth = 0; node && depth < 4 && pieces.length < 3; depth += 1) {
    let sibling = node.prev;
    while (sibling && pieces.length < 3) {
      const isBreak = sibling.type === "tag" && sibling.name === "br";
      // Another spoiler is a boundary: its content belongs to a different label.
      if (sibling.type === "tag" && /bbCodeBlock|bbCodeSpoiler/.test(sibling.attribs?.class || "")) return pieces.join(" ");
      const text = isBreak ? "" : normalizeWhitespace($(sibling).text());
      if (text) pieces.unshift(text.slice(-60));
      sibling = sibling.prev;
    }
    if (pieces.length) break;
    node = node.parent;
  }
  return pieces.join(" ");
}

function spoilerText($, spoilerNode) {
  const content = $(spoilerNode).find(".bbCodeBlock-content").first();
  const clone = content.length ? content.clone() : $(spoilerNode).clone();
  clone.find("br").replaceWith("\n");
  clone.find("p, div, li").each((_, node) => { $(node).append("\n"); });
  return String(clone.text() || "")
    .replace(/^[ \t]+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateAtLine(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n[...]`;
}

function extractChangelog($, article) {
  let changelog = null;
  article.find(".bbCodeSpoiler, .bbCodeBlock--spoiler").each((_, node) => {
    if (changelog || $(node).parents(".bbCodeSpoiler, .bbCodeBlock--spoiler").length) return;
    if (!CHANGELOG_LABEL_PATTERN.test(labelBeforeSpoiler($, node))) return;
    const text = spoilerText($, node);
    if (text) changelog = truncateAtLine(text, MAX_CHANGELOG_LENGTH);
  });
  return changelog;
}

function singleLineField(lines, label) {
  const pattern = new RegExp(`^${label}\\s*:`, "i");
  const line = lines.find((entry) => pattern.test(entry.text));
  return line ? normalizeWhitespace(line.text.replace(pattern, "")) || null : null;
}

// Links in the "Developer:" line that point away from the forum (Patreon, itch.io, ...), without the member profile.
function extractDeveloperLinks(lines) {
  const line = lines.find((entry) => /^developer\s*:/i.test(entry.text));
  const seen = new Set();
  const links = [];
  for (const link of line?.links || []) {
    if (/^https?:\/\/(?:www\.)?f95zone\.to\//i.test(link.url) || seen.has(link.url)) continue;
    seen.add(link.url);
    links.push({ label: link.label, url: link.url });
  }
  return links;
}

function toRating(value, count) {
  const rating = Number(value);
  const votes = Number(String(count ?? "").replace(/,/g, ""));
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return { rating: null, ratingCount: null };
  return { rating, ratingCount: Number.isInteger(votes) && votes >= 0 ? votes : null };
}

// Prefers the schema.org Book data, then the star widget in the page header.
function extractRating($) {
  for (const node of $("script[type='application/ld+json']").toArray()) {
    try {
      const data = JSON.parse($(node).contents().text());
      const aggregate = data?.["@type"] === "Book" ? data.aggregateRating : null;
      if (aggregate) {
        const result = toRating(aggregate.ratingValue, aggregate.ratingCount);
        if (result.rating !== null) return result;
      }
    } catch { /* malformed structured data: try the widget */ }
  }
  const widget = $("select[name='rating'][data-initial-rating]").first();
  if (widget.length) {
    const votes = textOf($(".br-current-rating").first()).match(/([\d,]+)\s*vote/i);
    return toRating(widget.attr("data-initial-rating"), votes?.[1]);
  }
  return { rating: null, ratingCount: null };
}

function extractVersionFromTitle(title) {
  const normalized = normalizeWhitespace(title);
  for (const pattern of VERSION_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      return sanitizeVersion(match[1]);
    }
  }
  return null;
}

function extractDeveloperFromTitle(title) {
  const normalized = normalizeWhitespace(title);
  const match = normalized.match(/\[([^\]]+)\]\s*$/);
  return match ? normalizeWhitespace(match[1]) : null;
}

function parseThreadTitle(rawTitle) {
  const normalized = normalizeWhitespace(rawTitle);
  const fullMatch = normalized.match(/^\[([^\]]+)\]\s*(.*?)\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*$/);
  if (fullMatch) {
    return {
      threadTitle: normalized,
      engine: normalizeWhitespace(fullMatch[1]) || null,
      title: normalizeWhitespace(fullMatch[2]) || normalized || "Unknown game",
      currentVersion: sanitizeVersion(fullMatch[3]) || null,
      developer: normalizeWhitespace(fullMatch[4]) || null
    };
  }

  const trailingMatch = normalized.match(/^(.*?)\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*$/);
  if (trailingMatch) {
    return {
      threadTitle: normalized || "Unknown game",
      title: normalizeWhitespace(trailingMatch[1]) || normalized || "Unknown game",
      engine: null,
      currentVersion: sanitizeVersion(trailingMatch[2]) || null,
      developer: normalizeWhitespace(trailingMatch[3]) || null
    };
  }

  const version = extractVersionFromTitle(normalized);
  const developer = extractDeveloperFromTitle(normalized);
  let title = normalized;

  if (developer) {
    title = normalizeWhitespace(title.replace(/\s*\[[^\]]+\]\s*$/, ""));
  }
  if (version) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = normalizeWhitespace(title.replace(new RegExp(`\\s*\\[${escapedVersion}\\]\\s*$`, "i"), ""));
  }
  title = normalizeWhitespace(title.replace(/^\[[^\]]+\]\s*/, ""));

  return {
    threadTitle: normalized || "Unknown game",
    title: title || normalized || "Unknown game",
    engine: null,
    currentVersion: version,
    developer
  };
}

function normalizeDownloadLabel(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized === "windows") {
    return "Windows";
  }
  return label;
}

// "win" / "pc" / "linux" at the start of a row, spelled the way the thread does for the combined labels.
function parsePlatformLabel(text) {
  const raw = String(text || "").replace(/\s*([/&,+])\s*/g, "$1");
  if (/^all$/i.test(raw)) return "All";
  if (/[/&,+]/.test(raw)) return raw;
  return /^(windows|win)$/i.test(raw) ? raw : parsePlatform(raw) || raw;
}

// A build that runs on Windows: a Windows / PC row, or an "All" row (HTML games, one archive for every system).
function isWindowsCapable(platform) {
  return /\b(?:win(?:dows)?|pc|all)\b/i.test(String(platform || ""));
}

// F95Zone plants hidden decoy links between the real ones ("u-hidden"); nothing inside a hidden node is content.
function isHiddenNode(node) {
  const attribs = node?.attribs || {};
  return /(?:^|\s)u-hidden(?:\s|$)/.test(attribs.class || "") ||
    Object.prototype.hasOwnProperty.call(attribs, "hidden") ||
    /display\s*:\s*none/i.test(attribs.style || "");
}

// The file host behind a link. Download links all point to f95zone.to/dl/..., so the host is read from the favicon
// the forum puts on the link, then from an old-style masked link, then from the address itself.
function linkHost(node, href) {
  const favicon = String(node?.attribs?.style || "").match(/\/ip3\/([a-z0-9.-]+)\.ico/i);
  if (favicon) return favicon[1].toLowerCase();
  try {
    const parsed = new URL(href);
    const masked = parsed.pathname.match(/^\/masked\/([^/]+)/i);
    if (/(^|\.)f95zone\.to$/i.test(parsed.hostname)) return masked ? masked[1].toLowerCase() : "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// The signed part of a download link changes with every page load; without it two loads of a thread compare equal.
function stripLinkTokens(value) {
  return String(value || "").replace(/(https?:\/\/f95zone\.to\/dl\/\d+\/)\?[^"'\s<>]*/gi, "$1");
}

function isDownloadsHeaderLine(text) {
  return /^downloads?\b[\s:.-]*$/i.test(String(text || "").trim());
}

function isDownloadRow(text) {
  return /^(win\/linux\/mac|win\/linux|windows|win|mac|android)(?:\s*\([^)]*\))?\s*:/i.test(String(text || "").trim());
}

// Download rows start with one or more platforms and may carry a variant before the colon:
// "Win/Linux (HQ):", "Win/Linux - Split:", "Win (Compatibility):", "All (Public):".
const PLATFORM_WORD = "win(?:dows)?|pc|linux|mac(?:os)?|android|ios";
const LOOSE_ROW_PATTERN = new RegExp(
  `^((?:${PLATFORM_WORD}|all)(?:\\s*[/&,+]\\s*(?:${PLATFORM_WORD}))*)(?![a-z])([^:]{0,40}):`, "i"
);

function isLooseDownloadRow(text) {
  return LOOSE_ROW_PATTERN.test(String(text || "").trim());
}

function cleanLabelText(text) {
  return normalizeWhitespace(String(text || "").replace(/^[\s\-–—:,+&([]+|[\s\-–—:,+&)\]]+$/g, ""));
}

// The variant a piece of text names: a known keyword (HQ, Compressed, Split ...) or the text itself ("Sandbox").
function variantFromText(text) {
  const known = parseVariant(text).variant;
  if (known) return known;
  if (/\bpart\s*\d/i.test(text)) return "Split";
  const cleaned = cleanLabelText(text);
  // "(v0.17.2.1)" names the build's version, not a variant.
  if (/^(?:v(?:ersion)?\.?\s*)?\d+(?:\.\d+)*[a-z]?(?:\s+\w+)?$/i.test(cleaned)) return "";
  return cleaned.length <= 30 ? cleaned : "";
}

// A short line without links inside the download section that describes the rows after it: a chapter / season
// ("Season 1", "Chapter 2 v0.5", "Season 1&2 + DLCs") and / or a variant ("Compressed", "Sandbox", "VN-S1").
function parseSectionHeading(text) {
  const value = normalizeWhitespace(text);
  if (!value || value.length > 60 || value.startsWith("*") || /[.!?]$/.test(value) || value.split(" ").length > 6) return null;
  if (isLooseDownloadRow(value) || isDownloadsHeaderLine(value)) return null;
  const branch = parseBranch(value);
  if (!branch) return { branch: null, version: null, variant: variantFromText(value) };
  const version = value.match(/\bv(?:ersion)?\.?\s*(\d[0-9a-z._-]*)/i);
  const rest = value.replace(branch.raw, " ").replace(version?.[0] || "", " ");
  return { branch: branchDisplayLabel(branch), version: sanitizeVersion(version?.[1]) || null, variant: variantFromText(rest) };
}

function isBlockBoundary(tagName) {
  return ["p", "li", "div", "td", "tr", "blockquote"].includes(tagName);
}

function createEmptyLine() {
  return {
    text: "",
    links: []
  };
}

// With markSpoilers the content of spoiler blocks stays in the result, wrapped in { spoilerOpen, title } and
// { spoilerClose } entries; the download section keeps older seasons and extra builds in spoilers.
function buildLogicalLines($, root, { markSpoilers = false } = {}) {
  const lines = [];
  let current = createEmptyLine();

  function pushCurrent() {
    const text = normalizeWhitespace(current.text);
    if (text || current.links.length > 0) {
      lines.push({
        text,
        links: [...current.links]
      });
    }
    current = createEmptyLine();
  }

  function walk(node) {
    if (!node) {
      return;
    }

    if (node.type === "text") {
      current.text += $(node).text();
      return;
    }

    if (node.type !== "tag") {
      return;
    }

    const tagName = String(node.name || "").toLowerCase();

    if (isHiddenNode(node)) {
      return;
    }

    if (tagName === "br") {
      pushCurrent();
      return;
    }

    if (markSpoilers && /(?:^|\s)bbCodeSpoiler(?:\s|$)/.test(node.attribs?.class || "")) {
      pushCurrent();
      const title = normalizeWhitespace($(node).find(".bbCodeSpoiler-button").first().text()).replace(/^spoiler\s*:?\s*/i, "");
      let content = $(node).find(".bbCodeBlock-content").first();
      if (!content.length) content = $(node).find(".bbCodeSpoiler-content").first();
      const children = content.length
        ? content.contents().toArray()
        : $(node).contents().toArray().filter((child) => !/bbCodeSpoiler-button/.test(child.attribs?.class || ""));
      lines.push({ text: "", links: [], spoilerOpen: true, title });
      children.forEach((child) => walk(child));
      pushCurrent();
      lines.push({ text: "", links: [], spoilerClose: true });
      return;
    }

    if (tagName === "a") {
      const href = $(node).attr("href");
      const label = textOf($(node));
      if (href && /^https?:/i.test(href)) {
        current.links.push({
          label: label || new URL(href).hostname,
          url: href,
          host: linkHost(node, href)
        });
      }
      current.text += label;
      return;
    }

    if (isBlockBoundary(tagName) && (current.text.trim() || current.links.length > 0)) {
      pushCurrent();
    }

    $(node)
      .contents()
      .each((_, child) => walk(child));

    if (isBlockBoundary(tagName)) {
      pushCurrent();
    }
  }

  root.contents().each((_, node) => walk(node));
  pushCurrent();
  return lines;
}

function cloneRootWithoutSpoilers(root) {
  const wrappedHtml = `<div data-parser-scope="true">${root.html() || ""}</div>`;
  const scoped = cheerio.load(wrappedHtml);
  const scope = scoped("[data-parser-scope='true']").first();

  scope
    .find(
      ".bbCodeSpoiler, .bbCodeBlock--spoiler, .js-spoiler, .spoiler, [data-xf-click='spoiler']"
    )
    .remove();

  return {
    $: scoped,
    root: scope
  };
}

function collectLinesFromField(lines, fieldName) {
  const pattern = FIELD_HEADER_PATTERNS[fieldName];
  if (!pattern) {
    return [];
  }

  const startIndex = lines.findIndex((line) => pattern.test(line.text));
  if (startIndex === -1) {
    return [];
  }

  const collected = [];
  const firstMatch = lines[startIndex].text.match(pattern);
  const firstValue = normalizeWhitespace(firstMatch?.[2] || "");
  if (firstValue) {
    collected.push(firstValue);
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const text = normalizeWhitespace(lines[index].text);
    if (!text) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    if (Object.values(FIELD_HEADER_PATTERNS).some((entry) => entry.test(text)) || isDownloadsHeaderLine(text) || isDownloadRow(text)) {
      break;
    }

    collected.push(text);
  }

  return collected;
}

function extractFieldText(lines, fieldName) {
  const collected = collectLinesFromField(lines, fieldName);
  if (collected.length === 0) {
    return null;
  }

  const text = collected.join("\n\n");
  if (fieldName === "overview") {
    return normalizeWhitespace(text.split(/thread updated\s*:/i)[0]);
  }

  return text;
}

// Everything after the "DOWNLOAD" heading. Threads without that heading fall back to all lines outside spoilers.
function extractDownloadSectionLines(lines, markedLines = lines) {
  const headerIndex = markedLines.findIndex((line) => !line.spoilerOpen && !line.spoilerClose && isDownloadsHeaderLine(line.text));
  if (headerIndex === -1) {
    return { lines, downloadsHeaderFound: false };
  }
  // A heading inside a spoiler belongs to that spoiler only; the section ends where the spoiler does.
  const sectionLines = [];
  let depth = 0;
  for (const line of markedLines.slice(headerIndex + 1)) {
    if (line.spoilerOpen) depth += 1;
    if (line.spoilerClose) {
      depth -= 1;
      if (depth < 0) break;
    }
    // A second "DOWNLOADS" heading starts something else (old builds, another edition); it is not merged in.
    if (depth === 0 && !line.spoilerOpen && !line.spoilerClose && isDownloadsHeaderLine(line.text)) break;
    sectionLines.push(line);
  }
  const hasRows = sectionLines.some((line) => line.links?.length && isLooseDownloadRow(line.text));
  return { lines: hasRows ? sectionLines : lines, downloadsHeaderFound: true };
}

// Reads the download rows. Short lines without links act as headings for the rows after them ("Season 1",
// "Compressed"), and so does the title of a spoiler; a heading placed right before a spoiler applies to its content.
// Rows inside a spoiler that nothing describes are grouped as "More".
function collectDownloadGroupsFromLines(lines) {
  const seen = new Set();
  const groups = new Map();
  const emptyContext = () => ({ branch: null, version: null, variant: "" });
  // `base` is what the current nesting level starts from; `context` adds the headings seen on that level.
  let base = emptyContext();
  let context = base;
  const stack = [];

  const applyHeading = (heading) => {
    if (heading.branch) context = { branch: heading.branch, version: heading.version, variant: heading.variant };
    else context = { ...context, variant: heading.variant };
  };

  lines.forEach((line) => {
    if (line.spoilerOpen) {
      const titled = line.title ? parseSectionHeading(line.title) : null;
      if (titled) applyHeading(titled);
      else if (!context.branch && !context.variant) context = { ...context, variant: "More" };
      stack.push(base);
      base = context;
      return;
    }
    if (line.spoilerClose) {
      // The heading in front of a spoiler is used up once the spoiler ends.
      base = stack.pop() || emptyContext();
      context = base;
      return;
    }

    const text = String(line.text || "").trim();
    const rowMatch = text.match(LOOSE_ROW_PATTERN);
    if (!rowMatch) {
      const heading = line.links.length === 0 ? parseSectionHeading(text) : null;
      if (heading) applyHeading(heading);
      return;
    }
    if (line.links.length === 0) {
      return;
    }

    const platform = normalizeDownloadLabel(parsePlatformLabel(rowMatch[1]));
    // Only Windows-capable builds are listed; Mac, Android and Linux-only rows are ignored.
    if (!isWindowsCapable(platform)) {
      return;
    }
    const rowBranch = parseBranch(rowMatch[2]);
    const rowVariant = variantFromText(rowBranch ? rowMatch[2].replace(rowBranch.raw, " ") : rowMatch[2]);
    const branch = (rowBranch ? branchDisplayLabel(rowBranch) : null) || context.branch || null;
    const variant = rowVariant || context.variant || "";
    const label = [branch, platform, variant].filter(Boolean).join(" · ");
    if (!groups.has(label)) {
      groups.set(label, {
        label,
        branch,
        platform,
        variant,
        branchVersion: !rowBranch && context.branch === branch ? context.version : null,
        links: []
      });
    }

    line.links.forEach((link) => {
      if (seen.has(link.url)) {
        return;
      }
      seen.add(link.url);
      groups.get(label).links.push(link);
    });
  });

  return [...groups.values()].filter((group) => group.links.length > 0);
}

function collectDownloadGroups($, root) {
  const scoped = cloneRootWithoutSpoilers(root);
  const logicalLines = buildLogicalLines(scoped.$, scoped.root);
  const section = extractDownloadSectionLines(logicalLines, buildLogicalLines($, root, { markSpoilers: true }));

  return {
    groups: collectDownloadGroupsFromLines(section.lines),
    logicalLines,
    sectionLines: section.lines,
    downloadsHeaderFound: section.downloadsHeaderFound
  };
}

function normalizeAssetUrl(sourceUrl, assetUrl) {
  const normalized = String(assetUrl || "").trim();
  if (!normalized || normalized.startsWith("data:")) {
    return null;
  }

  try {
    return new URL(normalized, sourceUrl).toString();
  } catch {
    return null;
  }
}

function stripThumbSegment(url) {
  return String(url || "").replace(/\/thumb\/(?=[^/]+$)/i, "/");
}

function getImageLikeSource($, node) {
  return String(
    $(node).attr("data-src") || $(node).attr("src") || $(node).attr("data-url") || ""
  ).trim();
}

function getPreferredImageSource($, node) {
  const directSource = getImageLikeSource($, node);
  const parentLink = $(node).closest("a").attr("href") || "";

  if (/\/thumb\//i.test(parentLink) === false && /^https?:/i.test(parentLink)) {
    return parentLink;
  }

  if (/\/thumb\//i.test(directSource)) {
    return stripThumbSegment(directSource);
  }

  return directSource;
}

function isContentImage($, node) {
  const imageNode = $(node);
  const classes = String(imageNode.attr("class") || "").toLowerCase();
  const alt = String(imageNode.attr("alt") || "").toLowerCase();
  const src = getPreferredImageSource($, node).toLowerCase();
  const tagName = String(node?.name || "").toLowerCase();

  if (/smilie|emoji|avatar|sprite|logo|icon/.test(classes) || /emoji|smilie|icon/.test(alt)) {
    return false;
  }

  return (
    /\.(png|jpe?g|webp|gif)(?:$|\?)/i.test(src) ||
    /attachments|proxy\.php\?image=/.test(src) ||
    (tagName === "div" && /lbcontainer|attachment|lightbox|zoomer/.test(classes) && /^https?:/i.test(src))
  );
}

function extractImageAssets($, root, sourceUrl) {
  const scoped = cloneRootWithoutSpoilers(root);
  const imageUrls = [];

  scoped.root.find("img, [data-src]").each((_, node) => {
    if (!isContentImage(scoped.$, node)) {
      return;
    }

    const url = normalizeAssetUrl(sourceUrl, getPreferredImageSource(scoped.$, node));

    if (url && !imageUrls.includes(url)) {
      imageUrls.push(url);
    }
  });

  return {
    bannerImageUrl: imageUrls[0] || null,
    screenshotImageUrls: imageUrls.slice(1)
  };
}

function detectAuthWall(html) {
  const text = String(html || "");
  return (
    /you must be logged-in to view/i.test(text) ||
    /register now and enjoy/i.test(text) ||
    /log in or register now/i.test(text) ||
    /login required/i.test(text)
  );
}

function detectLoginPage(url, html) {
  return /\/login\//i.test(String(url || "")) || /name="login"/i.test(String(html || ""));
}

function excerptAroundDownloads(html) {
  const source = String(html || "");
  const match = source.match(/.{0,180}(DOWNLOADS|Win\/Linux|Windows|Win:).{0,320}/is);
  return match ? normalizeWhitespace(match[0]) : "";
}

function parseThread(html, sourceUrl) {
  const $ = cheerio.load(html);
  const warnings = [];

  const titleNode = $(".p-title-value").first();
  const taggedEngine =
    normalizeWhitespace(
      titleNode.find("span[class^='pre-'], span[class*=' pre-'], a[class^='pre-'], a[class*=' pre-']").first().text()
    ) || null;
  const fullTitleText =
    textOf(titleNode) ||
    textOf($("title").first()).replace(/\s*\|\s*F95zone.*$/i, "") ||
    "Unknown game";
  const rawTitle = extractDisplayTitleText($, titleNode) || fullTitleText;
  const threadStatus = extractThreadStatus($, titleNode);
  const titlePrefixes = extractTitlePrefixes($, titleNode);
  const loggedInAttribute = $("html").attr("data-logged-in");
  const loggedIn = loggedInAttribute === "true";
  const guestView = loggedInAttribute === "false";

  let article = $(".message-threadStarterPost .message-body").first();
  if (!article.length) {
    article = $(".message-threadStarterPost .bbWrapper").first();
  }
  if (!article.length) {
    article = $("article.message--post .message-body").first();
  }
  if (!article.length) {
    article = $("article.message--post .bbWrapper").first();
  }
  if (!article.length) {
    article = $(".message-body").first();
  }
  if (!article.length) {
    article = $(".bbWrapper").first();
  }

  // Hidden decoy links must not reach the stored text, the link list or the change comparison.
  article.find("*").filter((_, node) => isHiddenNode(node)).remove();

  const opHtml = article.length ? stripLinkTokens(article.html() || "") : "";
  const opText = article.length ? String(article.text() || "") : "";

  if (!article.length) {
    warnings.push("Could not identify the opening post body.");
  }

  const titleParts = parseThreadTitle(rawTitle);
  // The version bracket says which chapter / season is current ("[S2 v1.45]"); the game's name is only asked when
  // the bracket names none ("Bite: Season One [v1.05 S2 Ep. 1]" is on season 2).
  const versionBranches = expandBranches(titleParts.currentVersion || "");
  const titleBranches = versionBranches.length ? versionBranches : expandBranches(rawTitle, { extended: false });
  const logicalLines = buildLogicalLines($, article.length ? article : $.root());

  const developer = titleParts.developer || null;
  const engine = extractEngineFromPrefixes(titlePrefixes) || taggedEngine || titleParts.engine || null;
  const overview = extractFieldText(logicalLines, "overview");
  const releaseDate = extractFieldText(logicalLines, "releaseDate");
  const { rating, ratingCount } = extractRating($);
  const changelog = article.length ? extractChangelog($, article) : null;

  const tags = [];
  $(".js-tagList a, .tagItem").each((_, node) => {
    const tag = textOf($(node));
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  });

  // The thread title is authoritative; the "Version:" field only fills in when the title has no version.
  const fieldVersion = sanitizeVersion(extractFieldText(logicalLines, "version"));
  const currentVersion = titleParts.currentVersion || fieldVersion || null;

  if (!currentVersion) {
    warnings.push("Could not confidently determine the current thread version.");
  }

  if (detectLoginPage(sourceUrl, html)) {
    warnings.push("The fetched page looks like a login page instead of the thread.");
  } else if (!article.length || (guestView && detectAuthWall(html) && opText.trim().length < 200)) {
    warnings.push("The fetched page looks like a restricted view without full thread content.");
  }

  const downloadExtraction = collectDownloadGroups($, article.length ? article : $.root());
  const downloadGroups = downloadExtraction.groups;
  if (downloadGroups.length === 0) {
    warnings.push(
      guestView
        ? "Download links are only visible when logged in to F95Zone."
        : "No download links were detected in the opening post."
    );
  }

  const imageAssets = extractImageAssets($, article.length ? article : $.root(), sourceUrl);
  // Thread covers (/data/covers/) are real artwork; any other og:image is just the site favicon.
  const ogImage = String($("meta[property='og:image']").attr("content") || "").trim();
  if (!imageAssets.bannerImageUrl && /\/data\/covers\//.test(ogImage)) {
    imageAssets.bannerImageUrl = normalizeAssetUrl(sourceUrl, ogImage);
  }
  const candidateBlocks = downloadExtraction.sectionLines
    .filter((line) => isDownloadRow(line.text))
    .map((line) => line.text.slice(0, 220));

  return {
    sourceUrl,
    threadTitle: titleParts.threadTitle,
    title: titleParts.title,
    currentVersion,
    titleBranches,
    developer,
    engine,
    threadStatus,
    overview,
    releaseDate,
    threadUpdated: singleLineField(logicalLines, "thread updated"),
    os: singleLineField(logicalLines, "os"),
    language: singleLineField(logicalLines, "language"),
    censored: singleLineField(logicalLines, "censored"),
    developerLinks: extractDeveloperLinks(logicalLines),
    rating,
    ratingCount,
    changelog,
    tags,
    bannerImageUrl: imageAssets.bannerImageUrl,
    screenshotImageUrls: imageAssets.screenshotImageUrls,
    rawOpHtml: opHtml,
    rawOpText: opText,
    downloadGroups,
    parserDebug: {
      articleFound: article.length > 0,
      articleNode: article.length ? article.get(0).tagName : null,
      articleClass: article.length ? article.attr("class") || "" : "",
      loggedIn,
      guestView,
      titlePrefixes,
      titleBranches,
      loginPageDetected: detectLoginPage(sourceUrl, html),
      authWallDetected: detectAuthWall(html),
      titleDetected: rawTitle,
      titleHeadingText: fullTitleText,
      parsedTitle: titleParts,
      threadStatus,
      candidateBlockCount: candidateBlocks.length,
      candidateBlocks: candidateBlocks.slice(0, 8),
      logicalLineCount: logicalLines.length,
      downloadsHeaderFound: downloadExtraction.downloadsHeaderFound,
      downloadGroupLabels: downloadGroups.map((group) => group.label),
      downloadLinkCount: downloadGroups.reduce((sum, group) => sum + group.links.length, 0),
      bannerImageUrl: imageAssets.bannerImageUrl,
      screenshotCount: imageAssets.screenshotImageUrls.length,
      opExcerpt: excerptAroundDownloads(opHtml)
    },
    warnings
  };
}

module.exports = {
  extractVersionFromTitle,
  parseThread,
  parseThreadTitle
};
