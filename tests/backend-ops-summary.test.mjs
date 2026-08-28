// Tests for harness/backend-ops/summary.mjs.
//
// This judge decides whether a model's ops are supported, and two earlier versions of it
// had holes that would have reported a pass for a run that proved nothing. Every case
// below is one of those holes, kept closed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BackendOpsSummary, classifyOutcome, countExpectedCases } from "../harness/backend-ops/summary.mjs";

const ESC = String.fromCharCode(27);
const caseLine = (op, params, outcome) => `  ${op}(${params}): ${outcome}`;

/** Feed whole text and finish, the way a caller normally would. */
function run(text, options) {
  const summary = new BackendOpsSummary(options);
  summary.feed(text);
  summary.flush();
  return summary;
}

function passingRun(count, options = {}) {
  const lines = ["Backend 1/2: WebGPU"];
  for (let i = 0; i < count; i++) lines.push(caseLine("MUL_MAT_ID", `n=${i}`, "OK"));
  lines.push("  " + count + "/" + count + " tests passed");
  lines.push("Backend 2/2: CPU", "  Skipping CPU backend");
  return run(lines.join("\n") + "\n", { expected: count, ...options });
}

test("a complete, all-OK run on the target backend passes", () => {
  const summary = passingRun(5);
  const { pass, reasons, section } = summary.verdict();

  assert.equal(pass, true, reasons.join("; "));
  assert.equal(section.name, "WebGPU");
  assert.equal(section.counts.OK, 5);
});

test("classifyOutcome separates the five outcomes", () => {
  assert.equal(classifyOutcome("OK"), "OK");
  assert.equal(classifyOutcome("FAIL"), "FAIL");
  assert.equal(classifyOutcome("not supported [WebGPU: WebGPU] "), "NOT_SUPPORTED");
  assert.equal(classifyOutcome("SKIPPED"), "SKIPPED");
  assert.equal(classifyOutcome("something new"), "UNKNOWN");
  // "not supported" must win over an incidental FAIL in the same message.
  assert.equal(classifyOutcome("not supported (would FAIL)"), "NOT_SUPPORTED");
});

test("lines that are not test cases are not counted as cases", () => {
  const summary = run(
    [
      "Backend 1/2: WebGPU",
      caseLine("MUL_MAT_ID", "n=0", "OK"),
      "  455/455 tests passed",
      "  Backend WebGPU: WebGPU: OK",
      "Backend 2/2: CPU",
      "  Skipping CPU backend",
      "2/2 backends passed",
      "OK",
    ].join("\n") + "\n",
    { expected: 1 },
  );

  assert.equal(summary.verdict().pass, true);
  assert.equal(summary.sections[0].counts.OK, 1, "only the one real case counts");
  assert.equal(summary.sections[1].counts.OK, 0, "Skipping CPU backend is not a case");
  assert.deepEqual(summary.selfReported, ["455/455 tests passed"]);
});

test("a FAIL that scrolled far above the end still blocks the pass", () => {
  // The page truncates its scrollback to the last few thousand lines. A judge reading
  // that array would no longer see this failure.
  const lines = ["Backend 1/2: WebGPU", caseLine("MUL_MAT_ID", "n=bad", "FAIL")];
  for (let i = 0; i < 5000; i++) lines.push(caseLine("MUL_MAT_ID", `n=${i}`, "OK"));

  const summary = run(lines.join("\n") + "\n", { expected: 5001 });
  const { pass, reasons } = summary.verdict();

  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /1 FAIL/.test(r)), reasons.join("; "));
});

test("cases that never printed are caught by the expected count", () => {
  // 450 of 500 ran, all OK. Without the expected count this looks perfect.
  const summary = passingRun(450, { expected: 500 });
  const { pass, reasons } = summary.verdict();

  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /observed 450 case\(s\), expected 500/.test(r)), reasons.join("; "));
});

test("two matching backend sections are ambiguous, not additive", () => {
  // 250 + 250 = 500 must not read as a complete run of 500.
  const lines = ["Backend 1/3: WebGPU: GPU-A"];
  for (let i = 0; i < 250; i++) lines.push(caseLine("MUL_MAT_ID", `a${i}`, "OK"));
  lines.push("Backend 2/3: WebGPU: GPU-B");
  for (let i = 0; i < 250; i++) lines.push(caseLine("MUL_MAT_ID", `b${i}`, "OK"));

  const summary = run(lines.join("\n") + "\n", { expected: 500 });
  const { pass, reasons, section } = summary.verdict();

  assert.equal(pass, false);
  assert.equal(section, null);
  assert.ok(reasons.some((r) => /ambiguous/.test(r)), reasons.join("; "));
});

test("OK on another backend does not count towards the target", () => {
  const summary = run(
    [
      "Backend 1/2: CPU",
      caseLine("MUL_MAT_ID", "n=0", "OK"),
      caseLine("MUL_MAT_ID", "n=1", "OK"),
      "Backend 2/2: WebGPU",
      caseLine("MUL_MAT_ID", "n=0", "OK"),
    ].join("\n") + "\n",
    { expected: 2 },
  );

  const { pass, reasons } = summary.verdict();
  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /observed 1 case\(s\), expected 2/.test(r)), reasons.join("; "));
});

test("an unclassified outcome blocks the pass", () => {
  const summary = run(
    ["Backend 1/1: WebGPU", caseLine("MUL_MAT_ID", "n=0", "OK"), caseLine("MUL_MAT_ID", "n=1", "weird new status")].join("\n") + "\n",
    { expected: 2 },
  );

  const { pass, reasons } = summary.verdict();
  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /1 UNKNOWN/.test(r)), reasons.join("; "));
});

test("NOT SUPPORTED and SKIPPED each block the pass", () => {
  for (const outcome of ["not supported [WebGPU: WebGPU] ", "SKIPPED"]) {
    const summary = run(
      ["Backend 1/1: WebGPU", caseLine("MUL_MAT_ID", "n=0", outcome)].join("\n") + "\n",
      { expected: 1 },
    );
    const { pass, reasons } = summary.verdict();
    assert.equal(pass, false, `${outcome} should not pass`);
    assert.ok(reasons.some((r) => /NOT_SUPPORTED|SKIPPED/.test(r)), reasons.join("; "));
  }
});

test("without an expected count, completeness is not claimed", () => {
  const summary = run(
    ["Backend 1/1: WebGPU", caseLine("MUL_MAT_ID", "n=0", "OK")].join("\n") + "\n",
    { expected: null },
  );

  const { pass, reasons } = summary.verdict();
  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /expected case count is unknown/.test(r)), reasons.join("; "));
});

test("cases printed before any backend section block the pass", () => {
  const summary = run(
    [caseLine("MUL_MAT_ID", "n=0", "OK"), "Backend 1/1: WebGPU", caseLine("MUL_MAT_ID", "n=1", "OK")].join("\n") + "\n",
    { expected: 1 },
  );

  const { pass, reasons } = summary.verdict();
  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /before any backend section/.test(r)), reasons.join("; "));
});

test("a case split across two chunks is still one case", () => {
  const summary = new BackendOpsSummary({ expected: 1 });
  summary.feed("Backend 1/1: WebGPU\n  MUL_MAT_ID(n=0): O");
  summary.feed("K\n");
  summary.flush();

  assert.equal(summary.verdict().pass, true, summary.verdict().reasons.join("; "));
  assert.equal(summary.sections[0].counts.OK, 1);
});

test("several cases in one chunk are counted separately", () => {
  const summary = new BackendOpsSummary({ expected: 2 });
  summary.feed(`Backend 1/1: WebGPU\n${caseLine("A", "x", "OK")}\n${caseLine("B", "y", "FAIL")}\n`);
  summary.flush();

  assert.equal(summary.sections[0].counts.OK, 1);
  assert.equal(summary.sections[0].counts.FAIL, 1);
});

test("CRLF output is handled", () => {
  const summary = new BackendOpsSummary({ expected: 1 });
  summary.feed(`Backend 1/1: WebGPU\r\n${caseLine("A", "x", "OK")}\r\n`);
  summary.flush();

  assert.equal(summary.sections[0].name, "WebGPU", "the section name must not keep the CR");
  assert.equal(summary.verdict().pass, true, summary.verdict().reasons.join("; "));
});

test("a final line with no newline is processed by flush()", () => {
  const summary = new BackendOpsSummary({ expected: 1 });
  summary.feed(`Backend 1/1: WebGPU\n${caseLine("A", "x", "OK")}`);
  assert.equal(summary.sections[0].counts.OK, 0, "not counted until flushed");

  summary.flush();
  assert.equal(summary.sections[0].counts.OK, 1);
});

test("ANSI colour around the outcome does not change the classification", () => {
  const summary = new BackendOpsSummary({ expected: 1 });
  summary.feed(`Backend 1/1: WebGPU\n  MUL_MAT_ID(n=0): ${ESC}[1;32mOK${ESC}[0m\n`);
  summary.flush();

  assert.equal(summary.sections[0].counts.OK, 1);
});

test("countExpectedCases counts non-empty lines", () => {
  assert.equal(countExpectedCases("a\nb\nc\n"), 3);
  assert.equal(countExpectedCases("a\nb\nc"), 3, "a missing trailing newline still counts");
  assert.equal(countExpectedCases("a\n\n  \nb\n"), 2, "blank and whitespace-only lines are not cases");
  assert.equal(countExpectedCases(""), 0);
});

test("format() leads with the verdict and shows why it failed", () => {
  const summary = passingRun(450, { expected: 500 });
  const text = summary.format();

  assert.match(text, /^VERDICT {12}: NOT A PASS/);
  assert.match(text, /observed 450 case\(s\), expected 500/);
  assert.match(text, /expected cases {5}: 500/);
});

test("a FAIL printed with its diagnostic on the same line is still counted", () => {
  // test-backend-ops prints a mismatch report inline, ahead of the case, so the line
  // does not begin with the usual two spaces. A pattern anchored to those spaces would
  // skip exactly the failures. Observed on a real Qwen3.6 run, where the only clue was
  // that the case count did not add up.
  const prefixed =
    "[GATED_DELTA_NET] inf mismatch: WebGPU: WebGPU=-inf CPU=-29140014225397204652094542203917959168.000000" +
    "   GATED_DELTA_NET(name=__fgdn_ch__-0,type=f32,ne=[4096,640,1,1],sources=f32[128,16,512,1]): FAIL";

  const summary = run(
    ["Backend 1/1: WebGPU", caseLine("A", "x", "OK"), prefixed].join("\n") + "\n",
    { expected: 2 },
  );

  assert.equal(summary.sections[0].counts.FAIL, 1, "the prefixed line is a case, not noise");
  assert.equal(summary.sections[0].counts.OK, 1);
  const { pass, reasons } = summary.verdict();
  assert.equal(pass, false);
  assert.ok(reasons.some((r) => /1 FAIL/.test(r)), reasons.join("; "));
});

test("per-backend and per-run summary lines are still not cases", () => {
  const summary = run(
    [
      "Backend 1/1: WebGPU",
      caseLine("A", "x", "OK"),
      "  Backend WebGPU: WebGPU: FAIL",
      "  131/132 tests passed",
      "1/2 backends passed",
    ].join("\n") + "\n",
    { expected: 1 },
  );

  assert.equal(summary.sections[0].counts.FAIL, 0, "the per-backend summary is not a case");
  assert.equal(summary.verdict().pass, true, summary.verdict().reasons.join("; "));
});
