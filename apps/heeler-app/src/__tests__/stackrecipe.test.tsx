import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce } from "../state";
const info = { mode: "mean", align: true, members: ["a.jpg", "b.jpg"], missing: [], rendered: [] };
const backend = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), stackInfo: vi.fn(async () => info), updateStack: backend.update }));
import { StackPanel } from "../ui/simple";
import { handleApiAsync } from "../api";
beforeEach(() => { backend.update.mockReset().mockResolvedValue(info); });
const canceled = () => reduce({ ...initialState(), activeImage: "stack" }, { type: "set_stack_canceled", image: "stack", on: true });

it.each(["stack-mode-median", "stack-align"])("a successful %s change resumes a canceled stack recipe", async (control) => {
  let s = canceled();
  const nonce = s.previewNonce;
  render(<StackPanel state={s} dispatch={(c) => { s = reduce(s, c); }} />);
  fireEvent.click(await screen.findByTestId(control));
  await waitFor(() => expect(s.stackCanceled).toEqual({}));
  expect(s.previewNonce).toBe(nonce + 1);
});

it("scripting resumes a stack after its member list changes", async () => {
  let s = canceled();
  const nonce = s.previewNonce;
  const out = await handleApiAsync(s, (c) => { s = reduce(s, c); }, "stack.configure", { id: "stack", members: ["a.jpg", "c.jpg"] });
  expect(out).toEqual({ data: info });
  expect(s.stackCanceled).toEqual({});
  expect(s.previewNonce).toBe(nonce + 1);
});
