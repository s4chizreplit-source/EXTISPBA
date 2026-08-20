import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";


// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  esbuild: {
    // Strip console.* and debugger in production builds to shrink bundle
    // and skip runtime work on every page load.
    drop: mode === "production" ? ["console", "debugger"] : [],
    legalComments: "none",
  },
  build: {
    // Modern browsers only → smaller, faster JS.
    target: "es2020",
    // Increase limit to suppress warnings for intentionally large chunks
    chunkSizeWarningLimit: 1000,
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: false,
    minify: "esbuild",
    // Let Rollup derive the dependency graph. Manually separating React from
    // libraries that call createContext during module initialization can form
    // a production-only circular chunk and leave the React import undefined.
  },
}));

