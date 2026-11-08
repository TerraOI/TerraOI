import { describe, expect, it } from "vitest";
import { evaluateProvisional, findProvisionalLineProblems, parseProvisionalRefs } from "./provisional.mjs";

const answered = { state: "closed", labels: ["question", "answered"] };

describe("parseProvisionalRefs", () => {
  it("reads issue numbers from the line", () =>
    expect(parseProvisionalRefs("text\nProvisional on: #12, #15 and #12\n")).toEqual([12, 15]));
  it("treats 'none' and a missing line as no refs", () => {
    expect(parseProvisionalRefs("Provisional on: none")).toEqual([]);
    expect(parseProvisionalRefs("no line here")).toEqual([]);
  });

  // The two #89 failures, pinned so neither can come back as a silent wrong answer.
  it("reads a directive wrapped in markdown emphasis, which used to pass the gate unseen", () =>
    expect(parseProvisionalRefs("**Provisional on: #37**")).toEqual([37]));
  it("does not turn a transparent 'none' sentence into four dependencies", () => {
    const body = "Provisional on: none. The ADR states at the top that it is proposed and blocked on #62, #65, #55 (and #67 for locale)";
    expect(parseProvisionalRefs(body)).toEqual([]);
    expect(findProvisionalLineProblems(body)).toHaveLength(1);
    expect(findProvisionalLineProblems(body)[0]).toMatch(/move the explanation to the next line/);
  });
  it("reports a refs line that carries prose instead of guessing which half is a dependency", () => {
    const body = "Provisional on: #12, #15 (the contrast and size numbers)";
    expect(parseProvisionalRefs(body)).toEqual([]);
    expect(findProvisionalLineProblems(body)[0]).toMatch(/list issue numbers only/);
  });
  it("ignores the HTML comment the PR template ships, so 'none' stays 'none'", () => {
    const body = "Provisional on: none   <!-- or #<question issue>; also add the `provisional` label (COORDINATION.md §6) -->";
    expect(parseProvisionalRefs(body)).toEqual([]);
    expect(findProvisionalLineProblems(body)).toEqual([]);
  });
  it("does not mistake prose about the gate for the gate itself", () => {
    const body = "The CI step reads the `Provisional on:` line from this description, so do not edit it after approval.";
    expect(parseProvisionalRefs(body)).toEqual([]);
    expect(findProvisionalLineProblems(body)).toEqual([]);
  });
  it("accepts a list-marker form and bare space-separated numbers", () => {
    expect(parseProvisionalRefs("- Provisional on: #12")).toEqual([12]);
    expect(parseProvisionalRefs("Provisional on: #12 #15")).toEqual([12, 15]);
  });
  it("flags a directive that names nothing", () =>
    expect(findProvisionalLineProblems("Provisional on:")).toHaveLength(1));
});

describe("evaluateProvisional", () => {
  it("passes an ordinary PR", () => expect(evaluateProvisional({ body: "Provisional on: none" }).ok).toBe(true));
  it("passes when every referenced question is answered", () =>
    expect(evaluateProvisional({ labels: ["provisional"], body: "Provisional on: #12", issues: { 12: answered } }).ok).toBe(true));
  it("blocks while a referenced question is open", () =>
    expect(evaluateProvisional({ body: "Provisional on: #12", issues: { 12: { state: "open", labels: ["question"] } } }).problems[0]).toMatch(/still open/));
  it("blocks a question closed without an answer", () =>
    expect(evaluateProvisional({ body: "Provisional on: #12", issues: { 12: { state: "closed", labels: ["question"] } } }).ok).toBe(false));
  it("requires the line when the label is set", () =>
    expect(evaluateProvisional({ labels: ["provisional"], body: "" }).problems[0]).toMatch(/no `Provisional on/));
  it("reports unknown issue numbers", () =>
    expect(evaluateProvisional({ body: "Provisional on: #99", issues: { 99: null } }).ok).toBe(false));
});
