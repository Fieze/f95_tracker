// Keyboard handling for the modal panels: focus moves into a dialog when it opens, Tab stays inside it,
// and focus returns to whatever opened it when it closes. Uses `state` from renderer-app.js.
const OVERLAY_PANELS = {
  settings: "#settings-panel",
  login: "#login-panel",
  "add-thread": "#add-thread-panel",
  "add-folder": "#add-folder-panel",
  "game-details": "#game-details-panel",
  "edit-folder": "#edit-folder-panel"
};
const FOCUSABLE = "a[href], button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])";

let focusedOverlay = null;
let focusReturnTarget = null;

function isFocusable(element) {
  return !element.disabled && !element.closest(".hidden, [hidden]") && element.getClientRects().length > 0;
}

function getPanelFocusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter(isFocusable);
}

function rememberFocusTarget() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  return { id: active.id || "", gameId: active.dataset?.gameId || "" };
}

function resolveFocusTarget(target) {
  if (!target) return null;
  if (target.id) return document.getElementById(target.id);
  if (target.gameId) return document.querySelector(`.game-tile-button[data-game-id="${target.gameId}"]`);
  return null;
}

// Called after every render: reacts only when the open dialog actually changed.
function manageOverlayFocus() {
  const current = state.openOverlay;
  if (current === focusedOverlay) return;
  const previous = focusedOverlay;
  focusedOverlay = current;
  if (current && !previous) focusReturnTarget = rememberFocusTarget();

  // The panels were shown synchronously by renderOverlays, so focus can move right away.
  if (current) {
    const panel = document.querySelector(OVERLAY_PANELS[current]);
    if (!panel) return;
    const focusables = getPanelFocusables(panel);
    const first = focusables.find((element) => !element.classList.contains("overlay-close")) || focusables[0];
    if (first) first.focus();
    else { panel.tabIndex = -1; panel.focus(); }
  } else if (previous) {
    const target = resolveFocusTarget(focusReturnTarget);
    if (target && isFocusable(target)) target.focus();
    focusReturnTarget = null;
  }
}

function trapOverlayFocus(event) {
  if (event.key !== "Tab" || !state.openOverlay) return;
  const panel = document.querySelector(OVERLAY_PANELS[state.openOverlay]);
  if (!panel || panel.classList.contains("hidden")) return;
  const items = getPanelFocusables(panel);
  if (items.length === 0) { event.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) { event.preventDefault(); first.focus(); }
  else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}

document.addEventListener("keydown", trapOverlayFocus);
