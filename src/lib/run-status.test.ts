import { describe, it, expect } from "vitest";
import {
  isTargetMetAutoCompleted,
  getUserFacingRunStatus,
  countsAsDelivered,
} from "./run-status";

/**
 * E2E acceptance tests for the 4 cancellation scenarios.
 * Source of truth: backend `error_message` written by execute-all-runs.
 */

const targetMetRun = {
  status: "cancelled",
  error_message:
    "Target met (asked=100, observed=120, public_delta=120, target=100) — cancelling remaining runs",
};

const userManualCancelOrder = {
  status: "cancelled",
  error_message: "Order cancelled by user",
};

const userManualCancelItem = {
  status: "cancelled",
  error_message: "Item cancelled by user",
};

const providerErrorCancel = {
  status: "cancelled",
  error_message: "Provider returned: insufficient_funds",
};

const adminParentCancel = {
  status: "cancelled",
  error_message: "Order cancelled by admin",
};

describe("Scenario 1 — Over-delivery / Target met", () => {
  it("is treated as auto-completed", () => {
    expect(isTargetMetAutoCompleted(targetMetRun)).toBe(true);
  });
  it("UI status maps to 'completed'", () => {
    expect(getUserFacingRunStatus(targetMetRun)).toBe("completed");
  });
  it("counts toward delivered totals", () => {
    expect(countsAsDelivered(targetMetRun)).toBe(true);
  });
});

describe("Scenario 2 — User manual cancel (with refund)", () => {
  it("order-level cancel is NOT auto-completed", () => {
    expect(isTargetMetAutoCompleted(userManualCancelOrder)).toBe(false);
    expect(getUserFacingRunStatus(userManualCancelOrder)).toBe("cancelled");
    expect(countsAsDelivered(userManualCancelOrder)).toBe(false);
  });
  it("item-level cancel is NOT auto-completed", () => {
    expect(isTargetMetAutoCompleted(userManualCancelItem)).toBe(false);
    expect(getUserFacingRunStatus(userManualCancelItem)).toBe("cancelled");
    expect(countsAsDelivered(userManualCancelItem)).toBe(false);
  });
});

describe("Scenario 3 — Provider error cancel", () => {
  it("stays cancelled in UI (no auto-complete)", () => {
    expect(isTargetMetAutoCompleted(providerErrorCancel)).toBe(false);
    expect(getUserFacingRunStatus(providerErrorCancel)).toBe("cancelled");
    expect(countsAsDelivered(providerErrorCancel)).toBe(false);
  });
});

describe("Scenario 4 — Parent order admin cancel", () => {
  it("stays cancelled in UI (no auto-complete, no delivered credit)", () => {
    expect(isTargetMetAutoCompleted(adminParentCancel)).toBe(false);
    expect(getUserFacingRunStatus(adminParentCancel)).toBe("cancelled");
    expect(countsAsDelivered(adminParentCancel)).toBe(false);
  });
});

describe("Edge cases", () => {
  it("case-insensitive 'Target met' prefix match", () => {
    expect(
      isTargetMetAutoCompleted({
        status: "CANCELLED",
        error_message: "TARGET MET (asked=5, observed=5, public_delta=5, target=5)",
      })
    ).toBe(true);
  });
  it("'canceled' US spelling also accepted", () => {
    expect(
      isTargetMetAutoCompleted({ status: "canceled", error_message: "target met x" })
    ).toBe(true);
  });
  it("non-cancelled status is never auto-completed", () => {
    expect(
      isTargetMetAutoCompleted({ status: "pending", error_message: "target met" })
    ).toBe(false);
  });
  it("null / empty inputs are safe", () => {
    expect(isTargetMetAutoCompleted(null)).toBe(false);
    expect(isTargetMetAutoCompleted(undefined)).toBe(false);
    expect(isTargetMetAutoCompleted({})).toBe(false);
  });
});
