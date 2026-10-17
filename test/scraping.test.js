const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AppService } = require("../src/main/services/appService");
const { CloudflareChallengeError, ThreadFetcher } = require("../src/main/services/threadFetcher");

const fixture = (name) => fs.readFile(path.join(__dirname, "fixtures", "threads", `${name}.html`), "utf8");
const threadUrl = "https://f95zone.to/threads/example-game.1/";

function htmlResponse(html, init = {}) {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

async function createService(t, { sessionFetch, cookies = [] } = {}) {
  const fetcherOptions = { minIntervalMs: 0, jitterMs: 0 };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f95-scrape-"));
  const service = new AppService({
    userDataPath: root,
    authSession: { cookies: { get: async () => cookies }, fetch: sessionFetch },
    folderWatcher: { start: async () => {}, stop: async () => {}, ignoreFile: () => {} },
    onStateChanged: () => {},
    fetcherOptions
  });
  await service.db.initialize();
  t.after(async () => {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return service;
}

test("thread fetcher prefers the Electron session fetch and reports Cloudflare challenges", async () => {
  const calls = [];
  const fetcher = new ThreadFetcher({
    cookies: { get: async () => [] },
    fetch: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? htmlResponse("<html>ok</html>")
        : new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } });
    }
  });
  const page = await fetcher.fetchThread(threadUrl);
  assert.equal(page.html, "<html>ok</html>");
  await assert.rejects(() => fetcher.fetchThread(threadUrl), (error) => error instanceof CloudflareChallengeError && /login window/.test(error.message));
  assert.equal(calls.length, 2);
});

test("thread fetcher treats other HTTP failures as plain errors", async () => {
  const fetcher = new ThreadFetcher({ cookies: { get: async () => [] }, fetch: async () => new Response("nope", { status: 404 }) });
  await assert.rejects(() => fetcher.fetchThread(threadUrl), /status 404/);
});

test("guests can add a thread; login state follows data-logged-in rather than the cookie", async (t) => {
  const html = await fixture("rpgm-guest");
  const service = await createService(t, {
    sessionFetch: async () => htmlResponse(html),
    cookies: [{ name: "xf_user", value: "stale", domain: "f95zone.to", path: "/" }]
  });
  assert.equal((await service.getAuthState()).loggedIn, true, "cookie alone looks logged in before any page was seen");

  const parsed = await service.loadThread(threadUrl);
  assert.equal(parsed.engine, "RPGM");
  assert.equal(parsed.parserDebug.guestView, true);
  const auth = await service.getAuthState();
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.sessionExpired, true);
});

test("a guest refresh keeps download links and hidden tags from an earlier logged-in sync", async (t) => {
  const loggedInHtml = await fixture("renpy-logged-in");
  const guestHtml = loggedInHtml
    .replace('data-logged-in="true"', 'data-logged-in="false"')
    .replace(/<b>Extras<\/b>[\s\S]*?<\/a>/, "")
    .replace(/<b><span style="font-size: 18px">DOWNLOAD[\s\S]*?<br>\s*<br>/, "")
    .replace(/<a href="\/tags\/incest\/"[^>]*>incest<\/a>/, "");
  assert.ok(!guestHtml.includes("DATANODES"), "guest fixture must not contain download links");
  assert.ok(!guestHtml.includes("incest"), "guest fixture must not contain the members-only tag");

  let currentHtml = loggedInHtml;
  const service = await createService(t, { sessionFetch: async () => htmlResponse(currentHtml) });
  const added = await service.addThread(threadUrl);
  assert.equal(added.downloadGroups.length, 1);
  assert.ok(added.tags.includes("incest"));

  currentHtml = guestHtml;
  const refreshed = await service.refreshGame(added.id);
  assert.equal(refreshed.downloadGroups.length, 1, "download links were wiped by a guest refresh");
  assert.deepEqual(refreshed.downloadGroups[0].links.map((link) => link.label), ["BUZZHEAVIER", "DATANODES", "MEGA", "PIXELDRAIN"]);
  assert.ok(refreshed.tags.includes("incest"), "members-only tag was dropped by a guest refresh");
});

test("verifyAuth reports the logged-in state stated by the page", async (t) => {
  const loggedOut = '<html id="XF" data-logged-in="false"><body></body></html>';
  const service = await createService(t, { sessionFetch: async () => htmlResponse(loggedOut) });
  const result = await service.verifyAuth();
  assert.equal(result.pageLoggedIn, false);
  assert.equal(result.ok, false);
});

const challengeResponse = () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } });

test("thread fetcher paces requests and serialises them", async () => {
  let time = 1000;
  const sleeps = [];
  const starts = [];
  const fetcher = new ThreadFetcher(
    { cookies: { get: async () => [] }, fetch: async () => { starts.push(time); return htmlResponse("<html></html>"); } },
    { minIntervalMs: 1500, jitterMs: 0, now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; } }
  );
  await Promise.all([fetcher.fetchThread(threadUrl), fetcher.fetchThread(threadUrl), fetcher.fetchThread(threadUrl)]);
  assert.deepEqual(sleeps, [1500, 1500]);
  assert.deepEqual(starts, [1000, 2500, 4000]);
});

test("after a challenge the fetcher pauses without contacting the site until it is reset or the cooldown ends", async () => {
  let time = 0;
  let calls = 0;
  const fetcher = new ThreadFetcher(
    { cookies: { get: async () => [] }, fetch: async () => { calls += 1; return calls === 1 ? challengeResponse() : htmlResponse("<html>ok</html>"); } },
    { minIntervalMs: 0, jitterMs: 0, cooldownMs: 600000, now: () => time }
  );
  await assert.rejects(() => fetcher.fetchThread(threadUrl), /browser check/);
  assert.equal(calls, 1);

  await assert.rejects(() => fetcher.fetchThread(threadUrl), (error) => error.challenge && /paused/.test(error.message));
  assert.equal(calls, 1, "a paused fetcher must not send further requests");

  fetcher.resetChallenge();
  assert.equal((await fetcher.fetchThread(threadUrl)).html, "<html>ok</html>");
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(() => fetcher.fetchThread(threadUrl), /browser check/);
  time += 600001;
  calls = 1;
  assert.equal((await fetcher.fetchThread(threadUrl)).html, "<html>ok</html>");
});

test("refreshing all games stops after the first browser check instead of retrying every game", async (t) => {
  let currentHtml = await fixture("renpy-logged-in");
  let requests = 0;
  const service = await createService(t, {
    sessionFetch: async () => { requests += 1; return currentHtml ? htmlResponse(currentHtml) : challengeResponse(); }
  });
  await service.addThread("https://f95zone.to/threads/example-game.1/");
  await service.addThread("https://f95zone.to/threads/example-two.2/");
  await service.addThread("https://f95zone.to/threads/example-three.3/");
  currentHtml = "";
  requests = 0;
  service.fetcher.cooldownMs = 600000;
  await service.refreshAllGames();
  assert.equal(requests, 1, "only the first request may reach the site");
  service.resumeAfterBrowserCheck();
  currentHtml = await fixture("renpy-logged-in");
  await service.refreshAllGames();
  assert.ok(requests > 1);
});

test("with a page loader, pages come from the loader and challenges still pause the fetcher", async () => {
  let time = 0;
  const calls = [];
  const fetcher = new ThreadFetcher(
    { cookies: { get: async () => [] }, fetch: async () => { throw new Error("session fetch must not be used for pages"); } },
    { minIntervalMs: 0, jitterMs: 0, cooldownMs: 600000, now: () => time }
  );
  fetcher.setPageLoader(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 2) throw new CloudflareChallengeError();
    return { url: `${url}final`, html: "<html data-logged-in=\"true\"></html>", status: 200 };
  });

  const page = await fetcher.fetchThread(threadUrl, { interactive: true });
  assert.equal(page.status, 200);
  assert.ok(page.url.endsWith("final"));
  assert.deepEqual(calls[0].options, { interactive: true });

  await assert.rejects(() => fetcher.fetchThread(threadUrl), (error) => error.challenge);
  await assert.rejects(() => fetcher.fetchThread(threadUrl), /paused/);
  assert.equal(calls.length, 2, "paused fetcher must not call the loader");
  time += 600001;
  assert.ok((await fetcher.fetchThread(threadUrl)).html);
});

test("user actions may show the browser check window, background refreshes never do", async (t) => {
  const html = await fixture("renpy-logged-in");
  const service = await createService(t, { sessionFetch: async () => htmlResponse(html) });
  const seen = [];
  service.fetcher.setPageLoader(async (url, options) => { seen.push(options.interactive); return { url, status: 200, html }; });

  const game = await service.addThread(threadUrl);
  await service.refreshGame(game.id);
  await service.refreshAllGames();
  assert.deepEqual(seen, [true, true, false]);
});

const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("images are fetched without request pacing, pages are paced", async () => {
  const sleeps = [];
  let time = 0;
  const fetcher = new ThreadFetcher(
    { cookies: { get: async () => [] }, fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) },
    { minIntervalMs: 1500, jitterMs: 0, now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; } }
  );
  for (let index = 0; index < 5; index += 1) await fetcher.fetchBinary(`https://attachments.f95zone.to/${index}.png`);
  assert.deepEqual(sleeps, [], "image downloads must not wait for the page pacing");
});

test("adding a thread in the background returns at once and reports through activities", async (t) => {
  const html = await fixture("renpy-logged-in");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = await createService(t, { sessionFetch: async () => { await gate; return htmlResponse(html); } });

  const started = service.addThreadInBackground(threadUrl);
  assert.equal(started.queued, true);
  assert.equal(service.addThreadInBackground(threadUrl).duplicate, true, "the same thread is not queued twice");
  assert.throws(() => service.addThreadInBackground("not a url"), /thread/i);

  let state = await service.getState();
  assert.equal(state.games.length, 0);
  assert.deepEqual(state.activities.map((entry) => [entry.kind, entry.status]), [["add-thread", "running"]]);
  assert.match(state.activities[0].label, /example game/i);

  release();
  await waitFor(async () => (await service.getState()).games.length === 1, "the import to finish");
  state = await service.getState();
  assert.equal(state.activities[0].status, "done");
  assert.match(state.activities[0].message, /Added Example Game/);
  service.dismissActivity(state.activities[0].id);
  assert.equal((await service.getState()).activities.length, 0);
});

test("a failed background import stays visible until it is dismissed", async (t) => {
  const service = await createService(t, { sessionFetch: async () => new Response("nope", { status: 404 }) });
  service.addThreadInBackground(threadUrl);
  await waitFor(async () => (await service.getState()).activities[0]?.status === "error", "the failure");
  const [failure] = (await service.getState()).activities;
  assert.match(failure.message, /status 404/);
  assert.equal(service.dismissActivity(failure.id), true);
  assert.deepEqual((await service.getState()).activities, []);
  // The address is free again afterwards.
  assert.equal(service.addThreadInBackground(threadUrl).queued, true);
  await waitFor(async () => (await service.getState()).activities.some((entry) => entry.status === "error"), "second failure");
});

test("refreshing all games reports progress and ends with a summary or the browser check", async (t) => {
  const html = await fixture("renpy-logged-in");
  let blocked = false;
  const progress = [];
  const service = await createService(t, {
    sessionFetch: async () => (blocked ? challengeResponse() : htmlResponse(html))
  });
  await service.addThread("https://f95zone.to/threads/example-game.1/");
  await service.addThread("https://f95zone.to/threads/example-two.2/");
  service.onStateChanged = () => {};
  const originalEmit = service.emitChange.bind(service);
  service.emitChange = () => { const entry = service.activities.find((a) => a.kind === "refresh-all"); if (entry?.progress) progress.push(`${entry.progress.done}/${entry.progress.total}`); originalEmit(); };

  await service.refreshAllGames();
  assert.ok(progress.includes("0/2") && progress.includes("1/2"), `progress was ${progress.join(",")}`);
  let [summary] = (await service.getState()).activities.filter((a) => a.kind === "refresh-all");
  assert.equal(summary.status, "done");
  assert.equal(summary.message, "2 games up to date");

  blocked = true;
  await service.refreshAllGames();
  [summary] = (await service.getState()).activities.filter((a) => a.kind === "refresh-all" && a.status === "error");
  assert.match(summary.message, /browser check/i);
});
