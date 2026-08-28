/**
 * Fail-closed verdict for test-backend-ops output.
 *
 * The program's own "n/n tests passed" line and its exit status count only the cases it
 * ran: NOT_SUPPORTED and SKIPPED hit a `continue` before tests_run++
 * (test-backend-ops.cpp:9121-9136), and the status is `n_ok == tests_run`. A run where
 * the backend declined every case still prints "0/0 tests passed" and exits 0.
 *
 * Two earlier versions of this judge had holes, so the rules here are deliberately
 * paranoid:
 *
 *   - Counting happens as output arrives. The page truncates its scrollback; a judge
 *     reading that same array would stop seeing failures that scrolled off.
 *   - Cases are attributed to the "Backend n/N: name" section they appear under, keyed
 *     by section rather than by name. Two WebGPU sections summing to the expected count
 *     is not a pass.
 *   - The expected number of cases comes from the input file, not from the output. A
 *     case that never printed at all is otherwise invisible: 450 of 500 printed and all
 *     OK would look perfect.
 *   - Anything unclassified counts against the verdict. If this parser cannot read a
 *     line, that is a defect here, and a defect here must not read as a pass.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");

/** "Backend 1/2: WebGPU" */
const SECTION_RE = /^Backend (\d+)\/(\d+): (.+)$/;

/**
 * "  MUL_MAT_ID(type_a=q2_K,...): OK" - an op, its parenthesised parameters, then the
 * outcome at end of line.
 *
 * Deliberately not anchored to the leading two spaces. A failing case can be printed
 * with its diagnostic prepended on the same line:
 *
 *   [GATED_DELTA_NET] inf mismatch: WebGPU=-inf CPU=-2.9e37   GATED_DELTA_NET(...): FAIL
 *
 * An anchored pattern skips exactly those lines - the failures - and the run then looks
 * clean apart from a count that does not add up. That is how a real FAIL was missed
 * here, caught only because the expected count did not match.
 *
 * Lines that are not cases have no parenthesised group before the colon, so they still
 * do not match: "Backend 1/2: WebGPU", "  Skipping CPU backend", "131/132 tests passed".
 */
const CASE_RE = /(\S+)\((.*)\): (.+)$/;

/** "  455/455 tests passed" - reported for reference only, never used to decide. */
const SELF_REPORTED_RE = /^\s*\d+\/\d+ tests passed$/;

export const STATUSES = ["OK", "FAIL", "NOT_SUPPORTED", "SKIPPED", "UNKNOWN"];

/**
 * Map the text after "): " to one of five buckets.
 *
 * "not supported" is checked before FAIL so a message that happens to contain both
 * words cannot be miscounted as a numerical failure, and vice versa.
 */
export function classifyOutcome(outcome) {
  const text = outcome.trim();
  if (/^OK\b/.test(text)) return "OK";
  if (/not supported/i.test(text)) return "NOT_SUPPORTED";
  if (/\bskipped\b/i.test(text)) return "SKIPPED";
  if (/\bFAIL\b/.test(text)) return "FAIL";
  return "UNKNOWN";
}

function emptyCounts() {
  return { OK: 0, FAIL: 0, NOT_SUPPORTED: 0, SKIPPED: 0, UNKNOWN: 0 };
}

const total = (counts) => STATUSES.reduce((sum, key) => sum + counts[key], 0);

export class BackendOpsSummary {
  /**
   * @param {object} [options]
   * @param {number|null} [options.expected] cases the input file declares; null when the
   *   run was not driven by a --test-file, in which case completeness cannot be claimed.
   * @param {RegExp} [options.target] which backend section this run is about.
   */
  constructor({ expected = null, target = /webgpu/i } = {}) {
    this.expected = expected;
    this.target = target;
    this.sections = [];
    this.current = null;
    // Cases printed before any "Backend n/N:" line. Not attributable to a backend, so
    // they are tracked separately and block a pass rather than being ignored.
    this.orphans = emptyCounts();
    this.selfReported = [];
    this.carry = "";
  }

  /**
   * Accept any slice of the output. Chunks are not assumed to be whole lines: they may
   * split mid-line, carry several lines, or use either newline convention. The judge
   * must not depend on how the caller happens to slice its writes.
   */
  feed(chunk) {
    this.carry += chunk;
    let at;
    while ((at = this.carry.indexOf("\n")) !== -1) {
      this.line(this.carry.slice(0, at));
      this.carry = this.carry.slice(at + 1);
    }
  }

  /** Process a trailing line that never got its newline. */
  flush() {
    if (this.carry.length > 0) {
      this.line(this.carry);
      this.carry = "";
    }
  }

  line(raw) {
    const text = raw.replace(ANSI, "").replace(/\r$/, "");

    const section = SECTION_RE.exec(text);
    if (section) {
      this.current = {
        index: Number(section[1]),
        of: Number(section[2]),
        name: section[3].trim(),
        counts: emptyCounts(),
      };
      this.sections.push(this.current);
      return;
    }

    if (SELF_REPORTED_RE.test(text)) {
      this.selfReported.push(text.trim());
      return;
    }

    const testCase = CASE_RE.exec(text);
    if (testCase) {
      const status = classifyOutcome(testCase[3]);
      (this.current ? this.current.counts : this.orphans)[status] += 1;
    }
  }

  targets() {
    return this.sections.filter((s) => this.target.test(s.name));
  }

  /**
   * @returns {{pass: boolean, reasons: string[], section: object|null}}
   */
  verdict() {
    const reasons = [];
    const targets = this.targets();
    const section = targets.length === 1 ? targets[0] : null;

    if (targets.length === 0) {
      reasons.push(`no backend section matching ${this.target} was seen`);
    } else if (targets.length > 1) {
      // Summing several sections would let two half-runs add up to a full one.
      reasons.push(
        `${targets.length} backend sections match ${this.target} ` +
          `(${targets.map((s) => `${s.index}/${s.of} ${s.name}`).join(", ")}); ` +
          "the target is ambiguous",
      );
    }

    const orphanTotal = total(this.orphans);
    if (orphanTotal > 0) {
      reasons.push(`${orphanTotal} case(s) appeared before any backend section`);
    }

    if (this.expected === null) {
      reasons.push(
        "expected case count is unknown (no --test-file), so completeness cannot be claimed",
      );
    } else if (this.expected <= 0) {
      reasons.push("expected case count is zero");
    }

    if (section && this.expected !== null && this.expected > 0) {
      const observed = total(section.counts);
      if (observed !== this.expected) {
        reasons.push(`observed ${observed} case(s), expected ${this.expected}`);
      }
      if (section.counts.OK !== this.expected) {
        reasons.push(`${section.counts.OK} OK, expected ${this.expected}`);
      }
      for (const status of ["FAIL", "NOT_SUPPORTED", "SKIPPED", "UNKNOWN"]) {
        if (section.counts[status] > 0) {
          reasons.push(`${section.counts[status]} ${status}`);
        }
      }
    }

    return { pass: reasons.length === 0, reasons, section };
  }

  format() {
    const { pass, reasons, section } = this.verdict();
    const counts = section ? section.counts : emptyCounts();
    const observed = section ? total(counts) : 0;

    const lines = [
      `VERDICT            : ${pass ? "PASS" : "NOT A PASS"}`,
      ...(pass ? [] : reasons.map((r) => `  - ${r}`)),
      "",
      `target section     : ${section ? `${section.index}/${section.of} ${section.name}` : "(none)"}`,
      `expected cases     : ${this.expected === null ? "unknown (no --test-file)" : this.expected}`,
      `observed cases     : ${observed}`,
      `  OK               : ${counts.OK}`,
      `  FAIL             : ${counts.FAIL}`,
      `  NOT SUPPORTED    : ${counts.NOT_SUPPORTED}`,
      `  SKIPPED          : ${counts.SKIPPED}`,
      `  UNKNOWN          : ${counts.UNKNOWN}`,
      "",
      `all sections       : ${
        this.sections.map((s) => `${s.index}/${s.of} ${s.name} (${total(s.counts)})`).join(" | ") || "(none)"
      }`,
      `self-reported      : ${this.selfReported.join(" | ") || "(none)"}`,
      "  ^ counts executed cases only; NOT SUPPORTED and SKIPPED are excluded, so neither",
      "    this line nor the exit status can decide a pass.",
    ];
    if (total(this.orphans) > 0) {
      lines.push("", `orphan cases       : ${total(this.orphans)} (printed before any backend section)`);
    }
    return lines.join("\n");
  }
}

/**
 * Cases the input declares. export-graph-ops writes one test object per line - its
 * serialize() ends with '\n' - and test-backend-ops reads them back with std::getline,
 * so non-empty lines is exactly the number of cases that should run.
 */
export function countExpectedCases(testFileText) {
  return testFileText.split("\n").filter((line) => line.trim().length > 0).length;
}
