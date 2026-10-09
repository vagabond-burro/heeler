import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ValueField, fmt } from "../ui/track";

function field(onCommit: (value: number) => void, options: {
  value?: number; scale?: number; step?: number; display?: (v: number) => string;
} = {}) {
  function Harness() {
    const [value, setValue] = useState(options.value ?? 300);
    return <ValueField param="dpi" label="Review DPI" value={value} lo={1} hi={65535}
      scale={options.scale} step={options.step ?? 1} display={options.display ?? String} onCommit={next => { onCommit(next); setValue(next); }} />;
  }
  render(<Harness />);
  return screen.getByLabelText("Review DPI") as HTMLInputElement;
}

describe("numeric export field keyboard commits", () => {
  it("Escape discards the draft without committing it on blur", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const input = field(commit);
    await user.clear(input);
    await user.type(input, "240");
    await user.keyboard("{Escape}");
    expect(input.value).toBe("300");
    expect(commit).not.toHaveBeenCalled();
  });

  it("Enter commits once even though it also leaves the field", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const input = field(commit);
    await user.clear(input);
    await user.type(input, "240");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("240");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(240);
  });

  it("arrows step the typed draft without a stale blur or duplicate commit", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const input = field(commit);
    await user.clear(input);
    await user.type(input, "240");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("241");
    expect(commit).toHaveBeenLastCalledWith(241);
    await user.tab();
    expect(input.value).toBe("241");
    expect(commit).not.toHaveBeenCalledWith(240);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("steps the underlying precision when no draft has been typed", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const input = field(commit, { value: 1.234, step: 0.01, display: v => fmt("gamma", v) });
    await user.click(input);
    expect(input.value).toBe("1.23");
    await user.keyboard("{ArrowUp}");
    expect(commit).toHaveBeenCalledWith(1.244);
    expect(input.value).toBe("1.24");
  });

  it("steps a scaled draft in displayed units", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    const input = field(commit, { value: 2, scale: 10 });
    await user.clear(input);
    await user.type(input, "25");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("26");
    expect(commit).toHaveBeenCalledWith(2.6);
    await user.tab();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
