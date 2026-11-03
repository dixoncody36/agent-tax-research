import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approveDisabled, approveHint, approverNameValid } from "./approveGate";

// Regression suite for #45: Approve rendered disabled with no explanation
// until a 3+ char approver name was typed. Run from repo root:
//   pnpm --filter @agent-tax-research/cli exec tsx --test ../../apps/web/app/review/approveGate.test.ts

describe("approverNameValid", () => {
  it("rejects empty, whitespace, and under-3 names", () => {
    assert.equal(approverNameValid(""), false);
    assert.equal(approverNameValid("   "), false);
    assert.equal(approverNameValid("Al"), false);
    assert.equal(approverNameValid(" Al "), false);
  });
  it("accepts real names", () => {
    assert.equal(approverNameValid("Cody Dixon"), true);
    assert.equal(approverNameValid("Sam"), true);
  });
});

describe("approveHint", () => {
  it("explains how to unlock while the name is missing/short", () => {
    assert.match(approveHint(""), /name/i);
    assert.match(approveHint("Al"), /name/i);
  });
  it("confirms who approvals will be recorded as once valid", () => {
    assert.equal(approveHint("Cody Dixon"), "Approving as Cody Dixon.");
  });
});

describe("approveDisabled", () => {
  it("disabled without a valid name, enabled with one", () => {
    assert.equal(approveDisabled("", null, "p1"), true);
    assert.equal(approveDisabled("Cody Dixon", null, "p1"), false);
  });
  it("disabled only for the busy proposal", () => {
    assert.equal(approveDisabled("Cody Dixon", "p1", "p1"), true);
    assert.equal(approveDisabled("Cody Dixon", "p2", "p1"), false);
  });
});
