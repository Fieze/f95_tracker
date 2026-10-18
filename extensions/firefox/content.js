// Shows a small overlay on F95Zone thread pages that offers to add the thread to the F95 Tracker app.
(() => {
  const match = location.pathname.match(/^\/threads\/([^./]+\.\d+)(?:\/|$)/);
  if (!match || window.top !== window) return;
  const threadUrl = `https://f95zone.to/threads/${match[1]}/`;

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .card { font: 13px/1.4 system-ui, sans-serif; color: #e8eaf0; background: #1b1e27; border: 1px solid #343a4a;
        border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.45); width: 250px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .title { font-weight: 600; flex: 1; }
      .msg { margin: 6px 0 0; color: #b4bac8; }
      button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #4d7cff; background: #4d7cff; color: #fff; padding: 5px 10px; }
      button.ghost { background: transparent; border-color: transparent; color: #b4bac8; padding: 0 4px; font-size: 16px; }
      button:disabled { opacity: .6; cursor: default; }
      .add { margin-top: 8px; width: 100%; }
      .ok { color: #6fd08c; } .err { color: #ff8a8a; }
    </style>
    <div class="card" role="region" aria-label="F95 Tracker">
      <div class="row"><span class="title">F95 Tracker</span><button class="ghost" id="close" aria-label="Hide">×</button></div>
      <p class="msg" id="msg">Checking…</p>
      <button class="add" id="add" hidden>Add to tracker</button>
      <button class="add" id="connect" hidden>Connect to F95 Tracker</button>
    </div>`;
  const msg = root.getElementById("msg");
  const addButton = root.getElementById("add");
  const connectButton = root.getElementById("connect");
  root.getElementById("close").addEventListener("click", () => host.remove());

  function show(text, kind = "") { msg.textContent = text; msg.className = `msg ${kind}`; }

  function render(result) {
    addButton.hidden = true;
    addButton.disabled = false;
    connectButton.hidden = true;
    connectButton.disabled = false;
    if (result?.ok) {
      if (result.tracked && result.game) return show(`Already tracked: ${result.game.title}`, "ok");
      if (result.tracked) return show("Already tracked.", "ok");
      if (result.pending || result.queued) return show("Adding… check the app's status line.", "ok");
      show("This thread is not in your tracker yet.");
      addButton.hidden = false;
      return;
    }
    if (result?.code === "no-token") {
      show("Not connected yet. The app will ask you to confirm once.");
      connectButton.hidden = false;
      return;
    }
    const messages = {
      denied: "The connection was denied in the app. Try again in a moment.",
      busy: "The app is already asking for confirmation.",
      offline: "F95 Tracker is not running."
    };
    show(messages[result?.code] || result?.error || "Something went wrong.", "err");
  }

  addButton.addEventListener("click", async () => {
    addButton.disabled = true;
    show("Adding…");
    const result = await browser.runtime.sendMessage({ type: "add", url: threadUrl });
    if (result?.ok && !result.tracked) show("Added to the queue. Progress shows in the app.", "ok");
    else render(result);
    addButton.hidden = true;
  });

  connectButton.addEventListener("click", async () => {
    connectButton.disabled = true;
    show("Waiting for your confirmation in the app…");
    const paired = await browser.runtime.sendMessage({ type: "pair" });
    if (!paired?.ok) return render(paired);
    show("Checking…");
    render(await browser.runtime.sendMessage({ type: "status", url: threadUrl }));
  });

  document.documentElement.appendChild(host);
  browser.runtime.sendMessage({ type: "status", url: threadUrl }).then(render, () => show("Extension error.", "err"));
})();
