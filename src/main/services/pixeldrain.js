// Pixeldrain through its public API (https://pixeldrain.com/api): a page address is turned into the file's direct
// download address, name, size and SHA-256, so the download starts without anyone clicking through the page.
// No I/O of its own: the caller passes the fetch function.

const API_BASE = "https://pixeldrain.com/api";
const ARCHIVE_PATTERN = /\.(zip|rar|7z)$/i;

// Restrictions that only the download page can lift (captcha) or that need a premium account.
class PixeldrainRestrictedError extends Error {
  constructor(code, message) {
    super(message || "Pixeldrain restricts this download.");
    this.name = "PixeldrainRestrictedError";
    this.code = code || "restricted";
    this.restricted = true;
  }
}

function isPixeldrainHost(host) {
  return /^(?:www\.)?pixeldrain\.(?:com|net|dev)$/i.test(String(host || ""));
}

// { kind: "file" | "list" | "filesystem", id, path } for a Pixeldrain address, or null.
//   /u/<id>, /api/file/<id>     a single file
//   /l/<id>                     a list (album) of files; "#item=2" selects one
//   /d/<id>[/sub/path]          a shared filesystem file or directory
function parsePixeldrainUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !isPixeldrainHost(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments[0] === "api") segments.shift();
  const [type, id, ...rest] = segments;
  if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
  if (type === "u" || type === "file") return { kind: "file", id };
  if (type === "l" || type === "list") {
    const item = Number(parsed.hash.match(/item=(\d+)/)?.[1]);
    return { kind: "list", id, item: Number.isInteger(item) ? item : null };
  }
  if (type === "d" || type === "filesystem") return { kind: "filesystem", id, path: rest };
  return null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function apiGet(fetchFn, url, signal) {
  const response = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "follow", signal });
  const body = await readJson(response);
  if (!response.ok || body.success === false) {
    const code = String(body.value || "");
    if (response.status === 404) throw new Error("This file no longer exists on Pixeldrain.");
    if (response.status === 451) throw new Error("This file was removed from Pixeldrain after a takedown report.");
    if (/captcha|hotlink|limit|max_concurrent/.test(code)) throw new PixeldrainRestrictedError(code, body.message);
    throw new Error(`Pixeldrain answered with status ${response.status}${code ? ` (${code})` : ""}.`);
  }
  return body;
}

function describeFile(info) {
  if (info.availability) throw new PixeldrainRestrictedError(info.availability, info.availability_message);
  return {
    url: `${API_BASE}/file/${encodeURIComponent(info.id)}?download`,
    fileName: String(info.name || ""),
    size: Number(info.size) || 0,
    sha256: /^[0-9a-f]{64}$/i.test(info.hash_sha256 || "") ? info.hash_sha256.toLowerCase() : ""
  };
}

function pickSingle(candidates, describe) {
  const archives = candidates.filter((entry) => ARCHIVE_PATTERN.test(describe(entry)));
  const pool = archives.length ? archives : candidates;
  // Several files to choose from is a decision for the user on the page itself.
  if (pool.length !== 1) throw new PixeldrainRestrictedError("multiple_files", "This Pixeldrain link holds several files.");
  return pool[0];
}

function filesystemUrl(id, pathSegments) {
  return `${API_BASE}/filesystem/${[id, ...pathSegments].map(encodeURIComponent).join("/")}`;
}

// Resolves a Pixeldrain address to one downloadable file: { url, fileName, size, sha256 }.
// Throws PixeldrainRestrictedError when the download needs the page (captcha, rate limit, several files).
async function resolvePixeldrainDownload(pageUrl, { fetch: fetchFn = fetch, signal } = {}) {
  const target = parsePixeldrainUrl(pageUrl);
  if (!target) throw new Error("Not a Pixeldrain address.");

  if (target.kind === "file") {
    return describeFile(await apiGet(fetchFn, `${API_BASE}/file/${encodeURIComponent(target.id)}/info`, signal));
  }

  if (target.kind === "list") {
    const list = await apiGet(fetchFn, `${API_BASE}/list/${encodeURIComponent(target.id)}`, signal);
    const files = Array.isArray(list.files) ? list.files : [];
    const chosen = target.item !== null && files[target.item] ? files[target.item] : pickSingle(files, (file) => String(file.name || ""));
    // The list only carries the basics; the file's own record has the checksum and the availability.
    return describeFile(await apiGet(fetchFn, `${API_BASE}/file/${encodeURIComponent(chosen.id)}/info`, signal));
  }

  const stat = await apiGet(fetchFn, `${filesystemUrl(target.id, target.path)}?stat`, signal);
  const nodes = Array.isArray(stat.path) ? stat.path : [];
  let node = nodes[Number.isInteger(stat.base_index) ? stat.base_index : nodes.length - 1];
  let nodePath = target.path;
  if (node?.type === "dir") {
    node = pickSingle((stat.children || []).filter((child) => child.type === "file"), (child) => String(child.name || ""));
    nodePath = [...target.path, node.name];
  }
  if (!node || node.type !== "file") throw new Error("This Pixeldrain link does not point to a file.");
  if (node.abuse_type) throw new Error("This file was removed from Pixeldrain after a takedown report.");
  return {
    url: `${filesystemUrl(target.id, nodePath)}?attach`,
    fileName: String(node.name || ""),
    size: Number(node.file_size) || 0,
    sha256: /^[0-9a-f]{64}$/i.test(node.sha256_sum || "") ? node.sha256_sum.toLowerCase() : ""
  };
}

module.exports = { PixeldrainRestrictedError, isPixeldrainHost, parsePixeldrainUrl, resolvePixeldrainDownload };
