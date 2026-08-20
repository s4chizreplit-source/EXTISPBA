import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/playfair-display/700-italic.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./index.css";

// A tab left open during a deployment can still reference a lazy-loaded chunk
// from the previous build. Vite emits this event when that hashed file no
// longer exists. Recover once with a fresh document instead of leaving every
// route behind the error boundary. The short guard prevents reload loops when
// the server is genuinely unavailable.
const CHUNK_RELOAD_KEY = "extips:chunk-reload-at";
window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();

    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0");
    if (Date.now() - lastReload < 60_000) return;

    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    window.location.reload();
});

// Aggressively unregister any previously installed service worker + nuke its caches.
// Old SW versions were serving stale assets and breaking deploys.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister().catch(() => {})))
        .catch(() => {});
    if (typeof caches !== "undefined") {
        caches.keys()
            .then((keys) => Promise.all(keys.map((k) => caches.delete(k).catch(() => false))))
            .catch(() => {});
    }
}

createRoot(document.getElementById("root")!).render(
    <App />
);
