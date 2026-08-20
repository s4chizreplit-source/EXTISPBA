// Service worker disabled — was causing stale-cache issues.
// main.tsx unregisters any existing SW on load. This file is a no-op kept
// only so existing client registrations resolve cleanly until unregistered.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
        await self.clients.claim();
        const regs = await self.registration ? [self.registration] : [];
        for (const reg of regs) { try { await reg.unregister(); } catch {} }
    })());
});
// No fetch handler — let the browser fetch everything directly.
