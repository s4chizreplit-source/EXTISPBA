// OrganicSMM Pro — background service worker (MV3)
// Handles side panel behavior, badge updates and notifications.

const APP_URL = "https://organicsmm.pro/";

// Allow the side panel to open on toolbar click when the user prefers it.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
  } catch (_) {}
});

// Cross-context messages from popup / side panel / injected content.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "badge:set") {
    const text = msg.text == null ? "" : String(msg.text).slice(0, 4);
    chrome.action.setBadgeText({ text }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "notify") {
    const id = `organicsmm-${Date.now()}`;
    chrome.notifications
      .create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: String(msg.title || "OrganicSMM Pro"),
        message: String(msg.message || ""),
        priority: 1,
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "open:app") {
    const url = typeof msg.url === "string" ? msg.url : APP_URL;
    chrome.tabs.create({ url }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

// Clicking a notification opens the app.
chrome.notifications.onClicked.addListener((notifId) => {
  chrome.tabs.create({ url: APP_URL }).catch(() => {});
  chrome.notifications.clear(notifId).catch(() => {});
});
