import { describe, expect, it } from "vitest";
import { useEffect, useState } from "react";
import { render } from "@testing-library/react";
import { withLoopStack } from "../log";

// React's update-loop warning names no component (console,
// 2026-09-30 12:31:47: the line said only "Maximum update depth
// exceeded"), so the tap adds the stack it was raised from.

/** An effect that sets state on every render: React's loop. */
function Looping() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < 200) setN(n + 1);
  });
  return <span>{n}</span>;
}

describe("the console tap on React's update-loop warning", () => {
  it("names the effect that looped", () => {
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(withLoopStack(args.map(String).join(" "), new Error().stack));
    };
    try {
      render(<Looping />);
    } finally {
      console.error = original;
    }
    const line = seen.find((m) => m.includes("Maximum update depth exceeded"));
    expect(line).toBeDefined();
    expect(line).toContain("Raised from:");
    // The effect itself: the setN inside Looping's useEffect.
    expect(line!.split("Raised from:")[1]).toMatch(/logloopstack\.test\.tsx:14:/);
  });

  it("leaves every other message as it was", () => {
    expect(withLoopStack("Export failed: disk full", new Error().stack)).toBe("Export failed: disk full");
    expect(withLoopStack("Maximum update depth exceeded.", undefined)).toBe("Maximum update depth exceeded.");
  });
});
