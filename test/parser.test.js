const test = require("node:test");
const assert = require("node:assert/strict");
const { extractVersionFromTitle, parseThread, parseThreadTitle } = require("../src/main/services/parser");

test("extractVersionFromTitle reads bracketed versions", () => {
  assert.equal(extractVersionFromTitle("[Ren'Py] Example Game [v0.5.1a] [Dev]"), "v0.5.1a");
});

test("parseThreadTitle extracts engine, game title, version and developer", () => {
  assert.deepEqual(parseThreadTitle("[Ren'Py] Example Game [v0.5.1a] [Dev Team]"), {
    threadTitle: "[Ren'Py] Example Game [v0.5.1a] [Dev Team]",
    title: "Example Game",
    engine: "Ren'Py",
    currentVersion: "v0.5.1a",
    developer: "Dev Team"
  });
});

test("parseThreadTitle extracts title, version and developer without engine prefix", () => {
  assert.deepEqual(parseThreadTitle("Summertime Saga [v21.0.0 wip.7164] [Kompas Productions]"), {
    threadTitle: "Summertime Saga [v21.0.0 wip.7164] [Kompas Productions]",
    title: "Summertime Saga",
    engine: null,
    currentVersion: "v21.0.0 wip.7164",
    developer: "Kompas Productions"
  });
});

test("parseThread extracts core OP metadata and links", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] Example Quest [v0.9] [Studio]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>Developer: Story Forge</p>
              <p>Engine: Ren'Py</p>
              <p>Overview: A short test story.</p>
              <p>Release Date: 2026-03-01</p>
              <p>Changelog:</p>
              <div class="bbCodeSpoiler">
                <p>Added one route.</p>
                <p>Fixed one bug.</p>
              </div>
              <p><img src="https://example.org/banner.jpg" /></p>
              <p><strong>Downloads</strong></p>
              <p>Win: <a href="https://example.org/mega">Mega</a> <a href="https://example.org/go">GoFile</a></p>
              <p>Android: <a href="https://example.org/android">APK</a></p>
              <p><img src="https://example.org/shot-1.jpg" /></p>
              <p><img src="https://example.org/shot-2.jpg" /></p>
            </div>
          </div>
        </article>
        <div class="js-tagList"><a>Male Protagonist</a><a>Adventure</a></div>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.1/");
  assert.equal(result.threadTitle, "[Ren'Py] Example Quest [v0.9] [Studio]");
  assert.equal(result.title, "Example Quest");
  assert.equal(result.currentVersion, "v0.9");
  assert.equal(result.developer, "Studio");
  assert.equal(result.engine, "Ren'Py");
  assert.equal(result.overview, "A short test story.");
  assert.equal(result.releaseDate, "2026-03-01");
  assert.equal(result.changelog, null);
  assert.deepEqual(result.tags, ["Male Protagonist", "Adventure"]);
  assert.equal(result.bannerImageUrl, "https://example.org/banner.jpg");
  assert.deepEqual(result.screenshotImageUrls, [
    "https://example.org/shot-1.jpg",
    "https://example.org/shot-2.jpg"
  ]);
  assert.equal(result.downloadGroups.length, 1);
  assert.equal(result.downloadGroups[0].label, "Win");
  assert.equal(result.downloadGroups[0].links.length, 2);
  assert.equal(result.downloadGroups[0].links.some((link) => link.url.includes("android")), false);
});

test("parseThread only keeps Win, Win/Linux and Windows download rows", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Unity] Platform Test [v1.0]</h1>
        <div class="message-body">
          <div class="bbWrapper">
            <p>DOWNLOADS</p>
            <p>Windows: <a href="https://example.org/windows">Host A</a></p>
            <p>Win/Linux: <a href="https://example.org/winlinux">Host B</a></p>
            <p>Mac: <a href="https://example.org/mac">Mac Link</a></p>
            <p>Android: <a href="https://example.org/android">APK</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.3/");
  assert.deepEqual(
    result.downloadGroups.map((group) => group.label),
    ["Windows", "Win/Linux"]
  );
  assert.equal(
    result.downloadGroups.flatMap((group) => group.links).some((link) => /mac|android/.test(link.url)),
    false
  );
});

test("parseThread finds allowed downloads when labels are wrapped around links", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] Wrapped Labels [v1.2]</h1>
        <div class="message-body">
          <div class="bbWrapper">
            <p>DOWNLOADS</p>
            <div><strong>Windows:</strong> <a href="https://example.org/a">Mega</a> <a href="https://example.org/b">GoFile</a></div>
            <div><strong>Mac:</strong> <a href="https://example.org/mac">Mac</a></div>
          </div>
        </div>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.4/");
  assert.equal(result.downloadGroups.length, 1);
  assert.equal(result.downloadGroups[0].label, "Windows");
  assert.equal(result.downloadGroups[0].links.length, 2);
});

test("parseThread finds downloads in br-separated opening post lines", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">VN Ren'Py Away from Home [Ep.1-29] [vatosgames]</h1>
        <article class="message-threadStarterPost">
          <article class="message-body js-selectToQuote">
            <div class="bbWrapper">
              <b>OS</b>: Windows, Mac, Linux<br>
              <b>DOWNLOADS</b><br>
              <b>Win/Linux:</b> <a href="https://example.org/win">Mega</a> <a href="https://example.org/linux">GoFile</a><br>
              <b>Mac:</b> <a href="https://example.org/mac">Mac Build</a><br>
            </div>
          </article>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.5/");
  assert.deepEqual(result.downloadGroups.map((group) => group.label), ["Win/Linux"]);
  assert.equal(result.downloadGroups[0].links.length, 2);
});

test("parseThread finds downloads when the label includes a version in parentheses", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] The Headmaster [v0.17.2.2]</h1>
        <article class="message-threadStarterPost">
          <article class="message-body js-selectToQuote">
            <div class="bbWrapper">
              <p><strong>DOWNLOAD</strong></p>
              Win/Linux (v0.17.2.1): <a href="https://example.org/win">Buzzheavier</a> - <a href="https://example.org/linux">Mega</a><br>
              Mac (v0.17.2.1): <a href="https://example.org/mac">Buzzheavier</a><br>
              Android (v0.12.3.1 Public): <a href="https://example.org/android">Mega</a>
            </div>
          </article>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.7/");
  assert.deepEqual(result.downloadGroups.map((group) => group.label), ["Win/Linux"]);
  assert.equal(result.downloadGroups[0].links.length, 2);
  assert.ok(result.warnings.every((warning) => !/No download links/i.test(warning)));
});

test("parseThread only uses the first download block after DOWNLOADS and skips spoiler content", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] Section Test [v2.0]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>Developer: Example Dev</p>
              <p><strong>DOWNLOADS</strong></p>
              <p>Windows: <a href="https://example.org/current">Current Build</a></p>
              <div class="bbCodeSpoiler">
                <p>Windows: <a href="https://example.org/spoiler">Spoiler Build</a></p>
              </div>
              <p>Extras: <a href="https://example.org/extras">Artbook</a></p>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/old">Old Build</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.6/");
  assert.equal(result.downloadGroups.length, 1);
  assert.equal(result.downloadGroups[0].label, "Windows");
  assert.deepEqual(
    result.downloadGroups[0].links.map((link) => link.url),
    ["https://example.org/current"]
  );
});

test("parseThread emits warnings when version or links are missing", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">Odd Thread Name</h1>
        <div class="message-body"><div class="bbWrapper"><p>No useful metadata.</p></div></div>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.2/");
  assert.ok(result.warnings.some((warning) => /version/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /download/i.test(warning)));
});

test("parseThread detects the banner from a lightbox div data-src", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Unity] Banner Test [v1.0] [Studio]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <div class="lbContainer-zoomer js-lbImage-attachment2847"
                   data-src="https://attachments.f95zone.to/2017/03/banner_large_2.jpg"
                   aria-label="Zoom"></div>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.7/");
  assert.equal(result.bannerImageUrl, "https://attachments.f95zone.to/2017/03/banner_large_2.jpg");
});

test("parseThread prefers the dedicated engine tag and keeps title/version/developer separate", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">
          <span class="pre-renpy" dir="auto">Ren'Py</span>
          Summertime Saga [v21.0.0 wip.7164] [Kompas Productions]
        </h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p><b>Release Date</b>: 2026-03-31</p>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.8/");
  assert.equal(result.title, "Summertime Saga");
  assert.equal(result.engine, "Ren'Py");
  assert.equal(result.currentVersion, "v21.0.0 wip.7164");
  assert.equal(result.developer, "Kompas Productions");
  assert.equal(result.releaseDate, "2026-03-31");
});

test("parseThread strips promo links and censored markers from developer field", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">Summertime Saga [v21.0.0 wip.7164] [Kompas Productions]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>Developer: Kompas Productions Patreon - Website - Wiki - Discord - Picarto Censored: No</p>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.9/");
  assert.equal(result.developer, "Kompas Productions");
});

test("parseThread keeps engine, version and developer strictly from the title area", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">
          <span class="pre-renpy" dir="auto">Ren'Py</span>
          Away from Home [Episode 1-29] [vatosgames]
        </h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>Version: Episode 1-29 OS: Windows, Mac, Linux Language: English Fan Art: Here Genre: Spoiler 3DCG</p>
              <p>Developer: Something Else Patreon - Website - Discord</p>
              <p><b>Release Date</b>: 2026-03-31</p>
              <p>DOWNLOADS</p>
              <p>Win/Linux: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.10/");
  assert.equal(result.engine, "Ren'Py");
  assert.equal(result.currentVersion, "Episode 1-29");
  assert.equal(result.developer, "vatosgames");
  assert.equal(result.releaseDate, "2026-03-31");
});

test("parseThread ignores non-engine title tags and keeps engine from the dedicated engine tag", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">
          <a href="/forums/games.2/?prefix_id=13" class="labelLink" rel="nofollow"><span class="label label--red" dir="auto">VN</span></a>
          <span class="label-append">&nbsp;</span>
          <a href="/forums/games.2/?prefix_id=7" class="labelLink" rel="nofollow"><span class="pre-renpy" dir="auto">Ren'Py</span></a>
          <span class="label-append">&nbsp;</span>
          Away from Home [Ep.1-29] [vatosgames]
        </h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>DOWNLOADS</p>
              <p>Win/Linux: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.13/");
  assert.equal(result.threadTitle, "Away from Home [Ep.1-29] [vatosgames]");
  assert.equal(result.title, "Away from Home");
  assert.equal(result.engine, "Ren'Py");
  assert.equal(result.currentVersion, "Ep.1-29");
  assert.equal(result.developer, "vatosgames");
});

test("parseThread extracts on-hold and abandoned style title prefixes", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">
          <a class="labelLink"><span class="label label--gray">On Hold</span></a>
          <span class="label-append">&nbsp;</span>
          <a class="labelLink"><span class="pre-unity">Unity</span></a>
          <span class="label-append">&nbsp;</span>
          Example Project [v0.4] [Dev Team]
        </h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.14/");
  assert.equal(result.threadStatus, "On Hold");
  assert.equal(result.engine, "Unity");
  assert.equal(result.title, "Example Project");
});

test("parseThread cuts overview before thread updated", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] Overview Test [v1.0] [Studio]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p>Overview: A long summary about the game. Thread Updated: 2026-04-01</p>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.11/");
  assert.equal(result.overview, "A long summary about the game.");
});

test("parseThread prefers full screenshot URLs over thumb images", () => {
  const html = `
    <html>
      <body>
        <h1 class="p-title-value">[Ren'Py] Screenshot Test [v1.0] [Studio]</h1>
        <article class="message-threadStarterPost">
          <div class="message-body">
            <div class="bbWrapper">
              <p><img src="https://example.org/banner.jpg" /></p>
              <p>
                <a href="https://attachments.f95zone.to/2017/03/16275_location_mombed04.jpg">
                  <img
                    src="https://attachments.f95zone.to/2017/03/thumb/16275_location_mombed04.jpg"
                    data-src="https://attachments.f95zone.to/2017/03/thumb/16275_location_mombed04.jpg"
                    class="bbImage lazyloaded"
                    alt="location_mombed04.jpg"
                  />
                </a>
              </p>
              <p>DOWNLOADS</p>
              <p>Windows: <a href="https://example.org/current">Current</a></p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;

  const result = parseThread(html, "https://f95zone.to/threads/example.12/");
  assert.deepEqual(result.screenshotImageUrls, [
    "https://attachments.f95zone.to/2017/03/16275_location_mombed04.jpg"
  ]);
});
