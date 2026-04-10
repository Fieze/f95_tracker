const { contextBridge } = require("electron");

function disableWebRtc() {
  const noop = () => {};
  const unsupported = () => {
    throw new Error("WebRTC is disabled in this download window.");
  };

  try {
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(window, "webkitRTCPeerConnection", {
      configurable: true,
      writable: true,
      value: undefined
    });
  } catch {
    // Ignore environments where the property cannot be redefined.
  }

  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = unsupported;
    navigator.mediaDevices.getDisplayMedia = unsupported;
    navigator.mediaDevices.enumerateDevices = async () => [];
  }

  window.MediaStream = undefined;
  window.MediaRecorder = undefined;
  window.webkitMediaStream = undefined;
  window.addEventListener("DOMContentLoaded", noop, { once: true });
}

disableWebRtc();

contextBridge.exposeInMainWorld("f95DownloadWindow", {
  webRtcDisabled: true
});
