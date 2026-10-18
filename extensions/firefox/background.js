// Talks to the F95 Tracker desktop app on the loopback interface. Content scripts never see the token.
const FIRST_PORT = 47950;
const PORT_COUNT = 10;

function request(port, path, options = {}, token = "") {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-F95-Token"] = token;
  return fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers, signal: AbortSignal.timeout(options.timeout || 2000) });
}

// The app takes the first free port of a small range; any JSON answer (even 401) on /v1/status means it is the bridge.
async function findPort() {
  const { port } = await browser.storage.local.get("port");
  const candidates = [port, ...Array.from({ length: PORT_COUNT }, (_, index) => FIRST_PORT + index)].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    try {
      const body = await (await request(candidate, "/v1/status")).json();
      if (typeof body.ok === "boolean") {
        if (candidate !== port) await browser.storage.local.set({ port: candidate });
        return candidate;
      }
    } catch { /* try the next port */ }
  }
  return 0;
}

async function callApp(path, options = {}) {
  const { token = "" } = await browser.storage.local.get("token");
  if (!token) return { ok: false, code: "no-token" };
  const port = await findPort();
  if (!port) return { ok: false, code: "offline" };
  let response;
  try {
    response = await request(port, path, { ...options, timeout: 8000 }, token);
  } catch {
    return { ok: false, code: "offline" };
  }
  if (response.status === 401) {
    await browser.storage.local.remove("token");
    return { ok: false, code: "no-token" };
  }
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { ok: false, code: "error", error: body.error || `HTTP ${response.status}` };
}

// Asks the app for the token; the user confirms in a dialog inside the app.
async function pair() {
  const port = await findPort();
  if (!port) return { ok: false, code: "offline" };
  try {
    const response = await request(port, "/v1/pair", { method: "POST", body: "{}", timeout: 120000 });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) return { ok: false, code: body.code || "denied" };
    await browser.storage.local.set({ token: body.token });
    return { ok: true };
  } catch {
    return { ok: false, code: "offline" };
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  // Only our own content script on F95Zone may use the bridge.
  if (sender.id !== browser.runtime.id || !sender.tab) return undefined;
  if (message?.type === "status") return callApp(`/v1/status?url=${encodeURIComponent(message.url)}`);
  if (message?.type === "add") return callApp("/v1/games", { method: "POST", body: JSON.stringify({ url: message.url }) });
  if (message?.type === "pair") return pair();
  return undefined;
});
