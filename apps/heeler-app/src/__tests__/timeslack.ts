// How much more time a test may take on this machine. Every time limit
// in the suites was tuned on the owner's Mac. The Linux VM runs about
// twice as slow under a full parallel run, and Windows is no better: a
// full run there takes three minutes, and a test that renders the whole
// App in about a second on its own missed waitFor's one-second limit
// under that load (2026-10-06: "when are we going to get this right
// where Windows keeps failing tests when mac is fine"). So the Mac is
// the reference and every other platform gets four times the room.
// vite.config.ts scales the per-test time limit by the same factor.
export const TIME_SLACK = (globalThis as { process?: { platform?: string } }).process?.platform === "darwin" ? 1 : 4;
