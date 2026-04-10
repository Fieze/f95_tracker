const cheerio = require("cheerio");
const { sanitizeVersion } = require("./utils");

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

function parseDownloadLabel(text) {
  const match = String(text || "").match(/^(win\/linux|windows|win)(?:\s*\([^)]*\))?\s*:/i);
  return match ? match[1] : null;
}

function normalizeDownloadLabel(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized === "windows") {
    return "Windows";
  }
  return label;
}

function isDownloadsHeaderLine(text) {
  return /^downloads?\b[\s:.-]*$/i.test(String(text || "").trim());
}

function isDownloadRow(text) {
  return /^(win\/linux|windows|win|mac|android)(?:\s*\([^)]*\))?\s*:/i.test(String(text || "").trim());
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

function buildLogicalLines($, root) {
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

    if (tagName === "br") {
      pushCurrent();
      return;
    }

    if (tagName === "a") {
      const href = $(node).attr("href");
      const label = textOf($(node));
      if (href && /^https?:/i.test(href)) {
        current.links.push({
          label: label || new URL(href).hostname,
          url: href
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

function extractDownloadSectionLines(lines) {
  const headerIndex = lines.findIndex((line) => isDownloadsHeaderLine(line.text));
  if (headerIndex === -1) {
    return {
      lines,
      downloadsHeaderFound: false
    };
  }

  const sectionLines = [];
  let inDownloadBlock = false;

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (isDownloadsHeaderLine(line.text)) {
      continue;
    }

    if (!inDownloadBlock) {
      if (isDownloadRow(line.text)) {
        inDownloadBlock = true;
        sectionLines.push(line);
      }
      continue;
    }

    if (!isDownloadRow(line.text)) {
      break;
    }

    sectionLines.push(line);
  }

  return {
    lines: sectionLines.length > 0 ? sectionLines : lines,
    downloadsHeaderFound: true
  };
}

function collectDownloadGroupsFromLines(lines) {
  const seen = new Set();
  const groups = new Map();

  lines.forEach((line) => {
    const label = parseDownloadLabel(line.text);
    if (!label || line.links.length === 0) {
      return;
    }

    const normalizedLabel = normalizeDownloadLabel(label);
    if (!groups.has(normalizedLabel)) {
      groups.set(normalizedLabel, []);
    }

    line.links.forEach((link) => {
      if (seen.has(link.url)) {
        return;
      }
      seen.add(link.url);
      groups.get(normalizedLabel).push(link);
    });
  });

  return [...groups.entries()]
    .map(([label, links]) => ({
      label,
      links
    }))
    .filter((group) => group.links.length > 0);
}

function collectDownloadGroups($, root) {
  const scoped = cloneRootWithoutSpoilers(root);
  const logicalLines = buildLogicalLines(scoped.$, scoped.root);
  const section = extractDownloadSectionLines(logicalLines);

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

  const opHtml = article.length ? article.html() || "" : "";
  const opText = article.length ? String(article.text() || "") : "";

  if (!article.length) {
    warnings.push("Could not identify the opening post body.");
  }

  const titleParts = parseThreadTitle(rawTitle);
  const logicalLines = buildLogicalLines($, article.length ? article : $.root());

  const developer = titleParts.developer || null;
  const engine = taggedEngine || titleParts.engine || null;
  const overview = extractFieldText(logicalLines, "overview");
  const releaseDate = extractFieldText(logicalLines, "releaseDate");
  const changelog = null;

  const tags = [];
  $(".js-tagList a, .tagItem").each((_, node) => {
    const tag = textOf($(node));
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  });

  const currentVersion = titleParts.currentVersion || null;

  if (!currentVersion) {
    warnings.push("Could not confidently determine the current thread version.");
  }

  if (detectLoginPage(sourceUrl, html)) {
    warnings.push("The fetched page looks like a login page instead of the thread.");
  } else if (detectAuthWall(html)) {
    warnings.push("The fetched page looks like a restricted view without full thread content.");
  }

  const downloadExtraction = collectDownloadGroups($, article.length ? article : $.root());
  const downloadGroups = downloadExtraction.groups;
  if (downloadGroups.length === 0) {
    warnings.push("No download links were detected in the opening post.");
  }

  const imageAssets = extractImageAssets($, article.length ? article : $.root(), sourceUrl);
  const candidateBlocks = downloadExtraction.sectionLines
    .filter((line) => isDownloadRow(line.text))
    .map((line) => line.text.slice(0, 220));

  return {
    sourceUrl,
    threadTitle: titleParts.threadTitle,
    title: titleParts.title,
    currentVersion,
    developer,
    engine,
    threadStatus,
    overview,
    releaseDate,
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
