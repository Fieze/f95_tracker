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
