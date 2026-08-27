import assert from "node:assert/strict";
import test from "node:test";
import {
  browserOpAllowed,
  emptyBrowserTurnBudget,
  noteBrowserOp,
} from "../src/browser-turn-budget.js";

test("a contentful observe after goto blocks further browser work", () => {
  const budget = emptyBrowserTurnBudget();
  noteBrowserOp(budget, "goto", { succeeded: true });
  assert.equal(browserOpAllowed(budget, "observe"), true);
  noteBrowserOp(budget, "observe", {
    succeeded: true,
    extracted: "Melatonin was first synthesized in 1958 by Aaron Lerner.",
  });
  assert.equal(browserOpAllowed(budget, "observe"), false);
  assert.equal(browserOpAllowed(budget, "click"), false);
  assert.equal(browserOpAllowed(budget, "close"), true);
});

test("two empty observes after goto also stop the loop", () => {
  const budget = emptyBrowserTurnBudget();
  noteBrowserOp(budget, "goto", { succeeded: true });
  noteBrowserOp(budget, "observe", { succeeded: true, extracted: "" });
  assert.equal(browserOpAllowed(budget, "observe"), true);
  noteBrowserOp(budget, "observe", { succeeded: true });
  assert.equal(browserOpAllowed(budget, "observe"), false);
});

test("observe before goto does not consume the page budget", () => {
  const budget = emptyBrowserTurnBudget();
  noteBrowserOp(budget, "observe", { succeeded: true });
  assert.equal(browserOpAllowed(budget, "goto"), true);
  assert.equal(budget.reads, 0);
});
