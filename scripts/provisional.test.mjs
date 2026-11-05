import { describe, expect, it } from "vitest";
import { evaluateProvisional, parseProvisionalRefs } from "./provisional.mjs";

const answered = { state: "closed", labels: ["question", "answered"] };

describe("parseProvisionalRefs", () => {
  it("reads issue numbers from the line", () =>
    expect(parseProvisionalRefs("text\nProvisional on: #12, #15 and #12\n")).toEqual([12, 15]));
  it("treats 'none' and a missing line as no refs", () => {
    expect(parseProvisionalRefs("Provisional on: none")).toEqual([]);
    expect(parseProvisionalRefs("no line here")).toEqual([]);
  });
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
