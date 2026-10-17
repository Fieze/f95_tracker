// Electron test for the hidden-window page loader against a local fake of F95Zone's Cloudflare behaviour.
// Run with: npm run test:loader
const assert = require("node:assert/strict");
const http = require("http");
const { app, session } = require("electron");
const { createBrowserPageLoader } = require("../src/main/browserPageLoader");
const { CloudflareChallengeError } = require("../src/main/services/threadFetcher");

const pages = {
  "/ok": () => ({ status: 200, body: '<html data-logged-in="true"><head><title>Game thread</title></head><body><img src="/pic.png"><p id="x">thread body</p></body></html>' }),
  "/slow-challenge": () => ({ status: 403, body: '<html><head><title>Just a moment...</title></head><body><script>setTimeout(() => location.replace("/ok"), 1200);</script></body></html>' }),
  "/stuck-challenge": () => ({ status: 403, body: "<html><head><title>Just a moment...</title></head><body>checking</body></html>" }),
  "/missing": () => ({ status: 404, body: "<html><head><title>Oops</title></head><body>not found</body></html>" })
};
const requested = [];
const server = http.createServer((req, res) => {
  requested.push(req.url);
  const page = (pages[req.url] || pages["/missing"])();
  res.writeHead(page.status, { "content-type": "text/html" });
  res.end(page.body);
});

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  let failure = null;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ses = session.fromPartition("persist:loader-test");
    const loader = createBrowserPageLoader({ partition: "persist:loader-test", session: ses, autoSolveMs: 4000, userSolveMs: 500, loadTimeoutMs: 10000 });

    const ok = await loader.load(`${base}/ok`);
    assert.match(ok.html, /data-logged-in="true"/);
    assert.match(ok.html, /thread body/);
    assert.equal(ok.status, 200);
    assert.ok(!requested.includes("/pic.png"), "images must not be requested");

    const solved = await loader.load(`${base}/slow-challenge`);
    assert.match(solved.html, /thread body/, "auto-solving challenge should end on the real page");
    assert.ok(solved.url.endsWith("/ok"));

    await assert.rejects(() => loader.load(`${base}/stuck-challenge`), (error) => error instanceof CloudflareChallengeError);
    await assert.rejects(() => loader.load(`${base}/stuck-challenge`, { interactive: true }), (error) => error instanceof CloudflareChallengeError);
    await assert.rejects(() => loader.load(`${base}/missing`), /status 404/);

    const again = await loader.load(`${base}/ok`);
    assert.match(again.html, /thread body/, "loader keeps working after failures");
    loader.dispose();
    console.log("loader checks passed");
  } catch (error) {
    failure = error;
    console.error(error.stack || error);
  }
  server.close();
  app.exit(failure ? 1 : 0);
});
