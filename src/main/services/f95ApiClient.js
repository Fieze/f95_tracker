const BASE_URL = "https://f95api.xyz";
class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ApiError("API request canceled."));
    const cancel = () => { clearTimeout(timer); reject(new ApiError("API request canceled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
class F95ApiClient {
  constructor(keyStore, { fetchImpl = fetch, now = Date.now, wait = abortableWait, timeoutMs = 30000 } = {}) {
    Object.assign(this, { keyStore, fetchImpl, now, wait, timeoutMs });
    this.controller = new AbortController();
    this.queue = Promise.resolve();
    this.nextRequestAt = 0;
    this.status = "not-tested";
    this.message = "";
    this.suspended = false;
  }
  reset() { this.suspended = false; this.status = "not-tested"; this.message = ""; }
  abort() { this.controller.abort(); }
  getState() { return { ...this.keyStore.getState(), status: this.status, message: this.message, suspended: this.suspended }; }
  request(route, params = {}) {
    const result = this.queue.then(() => this.performRequest(route, params));
    this.queue = result.catch(() => {});
    return result;
  }
  async performRequest(route, params) {
    try {
      if (!this.keyStore.key) throw new ApiError("Configure an F95 API key first.");
      if (this.suspended) throw new ApiError("API access paused. Save a valid key or test the connection again.");
      const url = new URL(route, BASE_URL);
      if (url.origin !== BASE_URL || !url.pathname.startsWith("/v1/")) throw new ApiError("Invalid API endpoint.");
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.wait(Math.max(0, this.nextRequestAt - this.now()), this.controller.signal);
        this.nextRequestAt = this.now() + 1000;
        const response = await this.fetchImpl(url.href, {
          headers: { "X-API-Key": this.keyStore.key }, redirect: "error",
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)])
        });
        if ([401, 403].includes(response.status)) this.suspended = true;
        if (response.status === 429) {
          await response.body?.cancel();
          const retry = response.headers.get("retry-after");
          const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now();
          this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + (Number.isFinite(seconds) ? Math.max(1000, seconds) : 2000 * 2 ** attempt));
          if (attempt < 2) continue;
        }
        if (!response.ok) throw new ApiError(`F95 API request failed (${response.status}).`, response.status);
        let data;
        try { data = await response.json(); } catch { throw new ApiError("F95 API returned invalid JSON."); }
        if (!data || typeof data !== "object") throw new ApiError("F95 API returned invalid data.");
        this.status = "connected";
        this.message = "API connection successful. Download access requires separate approval.";
        return data;
      }
    } catch (error) {
      // Never include response bodies, request headers or underlying network errors in logs/UI.
      const safe = error instanceof ApiError ? error : new ApiError(this.controller.signal.aborted ? "API request canceled." : "F95 API request timed out or could not connect.");
      this.status = "error"; this.message = safe.message;
      throw safe;
    }
  }
}
module.exports = { F95ApiClient, ApiError };
