// "Chapters & seasons" section of the game details: one row per branch with its installed / latest version, a
// variant choice, a download button and the manual controls (add, rename, remove, final). Uses helpers from
// renderer-app.js and activities.js.
const branchVariantChoice = new Map();

function groupsOfBranch(game, branch) {
  const groups = game.downloadGroups || [];
  const own = groups.filter((group) => group.branch === branch);
  if (own.length) return own;
  // A thread that names no chapter in its rows belongs to the newest branch of its title.
  const titleBranches = game.parserDebug?.titleBranches || [];
  return branch === titleBranches[titleBranches.length - 1] ? groups.filter((group) => !group.branch) : [];
}

function variantsOfBranch(game, branch) {
  return [...new Set(groupsOfBranch(game, branch).map((group) => group.variant || ""))];
}

// HQ is preferred when offered; split variants are never chosen by default because they cannot be downloaded here.
function defaultVariant(variants) {
  if (variants.includes("HQ")) return "HQ";
  return variants.find((variant) => variant !== "Split") ?? variants[0] ?? "";
}

function chosenVariant(game, branch) {
  const variants = variantsOfBranch(game, branch);
  const stored = branchVariantChoice.get(`${game.id}|${branch}`);
  return variants.includes(stored) ? stored : defaultVariant(variants);
}

// Starts the download of the newest build of one branch, in the chosen variant. Falls back to opening the page when
// no link of that group can be downloaded inside the app.
async function startBranchDownload(game, branch, variant) {
  const groups = groupsOfBranch(game, branch).filter((group) => (group.variant || "") === variant);
  if (!groups.length) throw new Error(`No download found for ${branch}.`);
  if (variant === "Split") throw new Error("Split archives are not supported by this app. Use \"Open page\" and download the parts yourself.");
  const group = groups[0];
  const link = group.links.find((entry) => isSupportedDirectDownload(entry.url, entry.label));
  if (!link) {
    window.f95App.openLink(group.links[0].url);
    return "opened";
  }
  await window.f95App.startDownload({
    gameId: game.id,
    linkId: link.id,
    url: link.url,
    label: link.label,
    detectedVersion: group.branchVersion || game.branchLatest?.[branch] || game.currentVersion || "",
    branch,
    variant
  });
  return "started";
}

async function runBranchAction(action) {
  try {
    await action();
  } catch (error) {
    alert(error.message);
  }
  await reloadState();
}

function renderBranchSection(block, game) {
  const list = block.querySelector(".branch-list");
  list.innerHTML = "";
  const states = game.branchStates || [];

  const updatable = states.filter((entry) => entry.hasUpdate && variantsOfBranch(game, entry.branch).length);
  if (updatable.length) {
    const updateAll = createNode("button", "primary", `Update ${updatable.length} outdated ${updatable.length === 1 ? "branch" : "branches"}`);
    updateAll.type = "button";
    updateAll.addEventListener("click", () => runBranchAction(async () => {
      for (const entry of updatable) await startBranchDownload(game, entry.branch, chosenVariant(game, entry.branch));
    }));
    list.appendChild(updateAll);
  }
  if (!states.length) list.appendChild(createNode("p", "field-hint", "No chapters or seasons detected. Add one if this game has several."));

  states.forEach((entry) => {
    const row = createNode("div", "branch-row");
    const info = createNode("div", "branch-info");
    info.appendChild(createNode("strong", "", entry.branch));
    const versions = [
      entry.installedVersion ? `Installed ${entry.installedVersion}` : "Not installed",
      entry.latestVersion ? `Latest ${entry.latestVersion}` : ""
    ].filter(Boolean).join(" · ");
    info.appendChild(createNode("small", "download-status", versions));
    if (entry.hasUpdate) info.appendChild(createNode("small", "download-status status-failed", "Update available"));
    if (entry.final) info.appendChild(createNode("small", "download-status", "Final"));
    row.appendChild(info);

    const actions = createNode("div", "branch-actions");
    const variants = variantsOfBranch(game, entry.branch);
    if (variants.length) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Variant for ${entry.branch}`);
      variants.forEach((variant) => {
        const option = new Option(variant || "Standard", variant);
        option.selected = variant === chosenVariant(game, entry.branch);
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        branchVariantChoice.set(`${game.id}|${entry.branch}`, select.value);
        renderBranchSection(block, game);
      });
      actions.appendChild(select);
      const split = chosenVariant(game, entry.branch) === "Split";
      const download = createNode("button", "download-button", split ? "Open page" : "Download latest");
      download.type = "button";
      download.addEventListener("click", () => runBranchAction(async () => {
        if (split) {
          const group = groupsOfBranch(game, entry.branch).find((candidate) => candidate.variant === "Split");
          window.f95App.openLink(group.links[0].url);
          return;
        }
        await startBranchDownload(game, entry.branch, chosenVariant(game, entry.branch));
      }));
      actions.appendChild(download);
      if (split) actions.appendChild(createNode("small", "download-status status-failed", "Split archives are not supported by this app."));
    }

    const finalLabel = createNode("label", "branch-final");
    const finalBox = document.createElement("input");
    finalBox.type = "checkbox";
    finalBox.checked = entry.final;
    finalBox.addEventListener("change", () => runBranchAction(() =>
      window.f95App.updateGameBranches({ gameId: game.id, action: "final", label: entry.branch, final: finalBox.checked })));
    finalLabel.append(finalBox, createNode("span", "", "Final"));
    actions.appendChild(finalLabel);

    const rename = createNode("button", "secondary compact", "Rename");
    rename.type = "button";
    rename.addEventListener("click", () => {
      const next = window.prompt(`New name for "${entry.branch}"`, entry.branch);
      if (next && next.trim() && next.trim() !== entry.branch) {
        runBranchAction(() => window.f95App.updateGameBranches({ gameId: game.id, action: "rename", label: entry.branch, newLabel: next.trim() }));
      }
    });
    const remove = createNode("button", "secondary compact danger-button", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => runBranchAction(() =>
      window.f95App.updateGameBranches({ gameId: game.id, action: "remove", label: entry.branch })));
    actions.append(rename, remove);
    row.appendChild(actions);
    list.appendChild(row);
  });

  const addRow = createNode("div", "branch-add");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add chapter, season or special (e.g. Chapter 5)";
  input.setAttribute("aria-label", "New chapter, season or special");
  const add = createNode("button", "secondary", "Add");
  add.type = "button";
  const submit = () => {
    if (input.value.trim()) runBranchAction(() => window.f95App.updateGameBranches({ gameId: game.id, action: "add", label: input.value.trim() }));
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  addRow.append(input, add);
  list.appendChild(addRow);
}
