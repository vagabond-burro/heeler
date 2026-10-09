/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Every time limit here is the Mac's, scaled for slower platforms by the
// same factor the tests read (src/__tests__/timeslack.ts says why).
import { TIME_SLACK as SLACK } from "./src/__tests__/timeslack";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2021" },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: false,
    testTimeout: 5_000 * SLACK,
    hookTimeout: 10_000 * SLACK,
  },
});
