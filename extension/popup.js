// Popup controller for OrganicSMM Pro extension.
// Loads the live web app inside an iframe and reuses all existing auth,
// APIs, database, and business logic — no duplicate frontend.

const APP_URL = "https://organicsmm.pro/";
const LAST_PATH_KEY = "organicsmm:last-path";

const iframe = document.getElementById("app");
const loader = document.getElementById("loader");

async function getStartUrl() {
  try {
    const { [LAST_PATH_KEY]: last } = await chrome.storage.local.get(LAST_PATH_KEY);
    if (last && typeof last === "string" && last.startsWith("/")) {
      return new URL(last, APP_URL).toString();
    }
  } catch (_) {}
  return APP_URL;
}

async function load() {
  const url = await getStartUrl();
  iframe.src = url;
}

iframe.addEventListener("load", () => {
  loader.classList.add("hidden");
  try {
    const path = new URL(iframe.src).pathname + new URL(iframe.src).search;
    chrome.storage.local.set({ [LAST_PATH_KEY]: path });
  } catch (_) {}
});

document.getElementById("btn-refresh").addEventListener("click", () => {
  loader.classList.remove("hidden");
  iframe.src = iframe.src;
});

document.getElementById("btn-open").addEventListener("click", async () => {
  const url = iframe.src && iframe.src !== "about:blank" ? iframe.src : APP_URL;
  await chrome.tabs.create({ url });
  window.close();
});

document.getElementById("btn-panel").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    }
  } catch (e) {
    console.warn("Side panel open failed", e);
  }
});

load();
