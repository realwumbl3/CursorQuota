const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

process.env.TZ = "America/New_York";
const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const context = vm.createContext({ Date, console });
vm.runInContext(source.slice(0, source.indexOf("  const observer =")) +
  "globalThis.quota = { resetFromText, billingPeriod, metrics, graphMarkup, enableChartZoom, parseSpending, dailyUsage, dailyUsageMarkup }; })();", context);
const { resetFromText, billingPeriod, metrics, graphMarkup, enableChartZoom, parseSpending, dailyUsage, dailyUsageMarkup } = context.quota;

const latest = (capturedAt, resetAt, used = 5, daysLeft = 29) => ({
  capturedAt: new Date(capturedAt).toISOString(), resetAt: new Date(resetAt).toISOString(),
  daysLeft, meters: { "Cursor Models": used, "Other Models": 2 }
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("daily allocations reconcile the screenshot total and preserve measured changes", () => {
  const sample = latest("2026-10-14T22:02:53-04:00", "2026-11-11T00:00:00-05:00", 5.11417);
  const history = [
    ["2026-10-11T19:06:13-04:00", 2], ["2026-10-11T23:21:43-04:00", 2],
    ["2026-10-12T21:40:02-04:00", 3], ["2026-10-12T23:12:59-04:00", 3],
    ["2026-10-13T00:11:51-04:00", 3], ["2026-10-13T13:38:54-04:00", 4],
    ["2026-10-14T15:51:35-04:00", 5]
  ].map(([capturedAt, used]) => ({ capturedAt, used, resetAt: sample.resetAt }));
  const days = dailyUsage(sample, "Cursor Models", history);
  assert.equal(days.length, 4);
  assert.equal(days[0].observed, "0.11417");
  assert.equal(days[1].observed, "1");
  const total = days.reduce((sum, day) => sum + BigInt(day.used.replace(".", "").padEnd(day.used.includes(".") ? day.used.indexOf(".") + 5 : day.used.length + 5, "0")), 0n);
  assert.equal(total, 511417n);
  assert.ok(Number(days[0].estimated) > 0);
  const markup = dailyUsageMarkup(sample, "Cursor Models", history);
  assert.ok(markup.includes(`<b>${days[0].used}%</b>`));
  assert.doesNotMatch(markup, /measured|estimated|Total:|<p>/);
});

test("same-day readings keep exact decimals with all earlier usage allocated", () => {
  for (const [start, end, expected] of [[5, 5.06333, "0.06333"], [0.1, 0.3, "0.2"], [1.0000000001, 1.0000000003, "0.0000000002"], [1e-7, 3e-7, "0.0000002"]]) {
    const sample = latest("2026-10-11T18:00:00-04:00", "2026-11-11T00:00:00-05:00", end);
    const history = [{ capturedAt: "2026-10-11T08:00:00-04:00", used: start, resetAt: sample.resetAt }];
    const days = dailyUsage(sample, "Cursor Models", history);
    assert.equal(days.length, 1);
    assert.equal(days[0].observed, expected);
    assert.equal(days[0].used, String(end).includes("e") ? "0.0000003" : String(end));
  }
});

test("unobserved days use time-weighted estimates and exact rounding", () => {
  const sample = latest("2026-10-14T00:00:00-04:00", "2026-11-11T00:00:00-05:00", 1);
  const days = dailyUsage(sample, "Cursor Models", []);
  assert.equal(days.length, 3);
  assert.deepEqual(Array.from(days, day => day.used), ["0.33333", "0.33333", "0.33334"]);
  assert.ok(days.every(day => day.observed === "0"));
  const zero = dailyUsage(latest("2026-10-11T00:00:00-04:00", sample.resetAt, 0), "Cursor Models", []);
  assert.equal(zero[0].used, "0");
});

test("fully measured days stay exact and daylight saving uses actual day lengths", () => {
  const sample = latest("2026-11-02T00:00:00-05:00", "2026-11-11T00:00:00-05:00", 49);
  const entry = (capturedAt, used) => ({ capturedAt, used, resetAt: sample.resetAt });
  const days = dailyUsage(sample, "Cursor Models", [entry("2026-10-31T00:00:00-04:00", 0)]);
  assert.equal(days[0].used, "25");
  assert.equal(days[1].used, "24");
  const measured = dailyUsage(sample, "Cursor Models", [entry("2026-11-01T00:00:00-04:00", 40), entry("2026-11-01T23:59:59-05:00", 49)]);
  assert.equal(measured[0].used, "9");
  assert.equal(measured[0].observed, "9");
  assert.equal(measured[0].estimated, "0");
});

test("invalid, stale, duplicate, and decreasing readings cannot create negative allocations", () => {
  const sample = latest("2026-10-11T18:00:00-04:00", "2026-11-11T00:00:00-05:00", 8);
  const entry = (capturedAt, used, resetAt = sample.resetAt) => ({ capturedAt, used, resetAt });
  const days = dailyUsage(sample, "Cursor Models", [
    entry("invalid", 3), entry("2026-10-11T19:00:00-04:00", 9),
    entry("2026-10-11T08:00:00-04:00", NaN), entry("2026-10-11T09:00:00-04:00", -1),
    entry("2026-10-11T07:00:00-04:00", 7, "2026-10-11T00:00:00-04:00"),
    entry("2026-10-11T10:00:00-04:00", 9), entry("2026-10-11T12:00:00-04:00", 5),
    entry(sample.capturedAt, 100)
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].used, "8");
  assert.equal(days[0].observed, "3");
  assert.equal(days[0].estimated, "5");
});

test("many uneven intervals conserve every decimal unit in totals and breakdowns", () => {
  const sample = latest("2026-11-10T18:43:21-05:00", "2026-11-11T00:00:00-05:00", 73.123456789);
  const start = billingPeriod(sample).billingStart;
  const end = new Date(sample.capturedAt).getTime();
  const history = Array.from({ length: 70 }, (_, index) => ({
    capturedAt: new Date(start + (end - start) * ((index + 1) / 72) ** 1.7).toISOString(),
    used: Number((73 * ((index + 1) / 72) ** 1.3).toFixed(9)), resetAt: sample.resetAt
  }));
  const units = (value) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(9, "0"));
  };
  const days = dailyUsage(sample, "Cursor Models", history);
  assert.equal(days.reduce((sum, day) => sum + units(day.used), 0n), 73123456789n);
  for (const day of days) {
    assert.equal(units(day.used), units(day.observed) + units(day.estimated));
    assert.ok(units(day.observed) >= 0n && units(day.estimated) >= 0n);
  }
});

test("spending reads full bar precision, including zero, and falls back per meter", () => {
  const parse = (cursorWidth, otherWidth) => {
    const labels = ["Cursor Models", "Other Models"].map((label, index) => ({
      textContent: label,
      closest: () => ({
        innerText: `${label} ${index === 0 ? 5 : 2}% used`,
        querySelector: () => [cursorWidth, otherWidth][index] === null ? null : { style: { width: [cursorWidth, otherWidth][index] } }
      })
    }));
    context.document = {
      body: { innerText: "Usage limits reset on Nov 11 (29 days left)" },
      querySelectorAll: () => labels
    };
    return parseSpending().meters;
  };
  let meters = parse("4.75%", "1.78182%");
  assert.equal(meters["Cursor Models"], 4.75);
  assert.equal(meters["Other Models"], 1.78182);
  meters = parse("0%", "0.1234567890%");
  assert.equal(meters["Cursor Models"], 0);
  assert.equal(meters["Other Models"], 0.123456789);
  meters = parse("4.75%", null);
  assert.equal(meters["Cursor Models"], 4.75);
  assert.equal(meters["Other Models"], 2);
  for (const width of [null, "", "2px", "auto", "NaN%", "-1%", "calc(5% - 2px)"]) {
    meters = parse(width, width);
    assert.equal(meters["Cursor Models"], 5);
    assert.equal(meters["Other Models"], 2);
  }
  context.getComputedStyle = () => ({ getPropertyValue: () => " 1.78182% " });
  assert.equal(parse("4.75%", "var(--usage)")["Other Models"], 1.78182);
  context.getComputedStyle = () => ({ getPropertyValue: () => "" });
  assert.equal(parse("4.75%", "var(--missing)")["Other Models"], 2);
});

test("screenshot projection uses the calendar month and a consistent time range", () => {
  const sample = latest("2026-10-14T15:51:35-04:00", "2026-11-11T23:59:59-05:00");
  const result = metrics(sample, "Cursor Models");
  assert.equal(new Date(result.period.billingStart).toISOString(), "2026-10-11T04:00:00.000Z");
  assert.ok(result.projected > 42 && result.projected < 43);
  assert.ok(metrics(sample, "Other Models").projected > 16 && metrics(sample, "Other Models").projected < 18);
  close(result.projected, result.daily * ((result.period.resetAt - result.period.billingStart) / 86400000));
  close(result.remainingDaily * result.period.remainingDays, 95);
  // Rounded page countdowns must not change the calculation or chart period.
  close(result.projected, metrics({ ...sample, daysLeft: 28 }, "Cursor Models").projected);
});

test("monthly starts handle February, leap years, month ends, and year boundaries", () => {
  for (const [reset, expectedStart] of [
    ["2026-03-31", "2026-02-28"], ["2024-03-31", "2024-02-29"],
    ["2026-05-31", "2026-04-30"], ["2027-01-11", "2026-12-11"],
    ["2026-03-11", "2026-02-11"], ["2026-10-11", "2026-09-11"]
  ]) {
    const period = billingPeriod(latest(`${expectedStart}T12:00:00`, `${reset}T00:00:00`));
    const start = new Date(period.billingStart);
    assert.equal(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`, expectedStart);
    assert.equal(start.getHours(), 0);
  }
});

test("reset date parsing keeps today and advances December resets into next year", () => {
  assert.equal(new Date(resetFromText("reset on Oct 14 (1 hour left)", new Date("2026-10-14T12:00:00"))).getFullYear(), 2026);
  const next = new Date(resetFromText("reset on Jan 11 (29 days left)", new Date("2026-12-14T12:00:00")));
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getHours(), 0);
});

test("zero elapsed time has no invented pace, and overused quota has no negative budget", () => {
  const start = metrics(latest("2026-10-11T00:00:00", "2026-11-11T00:00:00"), "Cursor Models");
  assert.equal(start.daily, null);
  assert.equal(start.projected, null);
  assert.equal(metrics(latest("2026-10-20T12:00:00", "2026-11-11T00:00:00", 110), "Cursor Models").remainingDaily, 0);
  const nearReset = metrics(latest("2026-11-10T12:00:00", "2026-11-11T00:00:00", 90), "Cursor Models");
  close(nearReset.remainingDaily, 20);
});

test("chart retains current-cycle history and replaces stale current readings", () => {
  const sample = latest("2026-10-14T15:51:35-04:00", "2026-11-11T00:00:00-05:00");
  const history = [
    { ...sample, used: 1, capturedAt: "2026-10-11T12:00:00-04:00", resetAt: "2026-10-11T23:59:59-04:00" },
    { ...sample, used: 2, capturedAt: "2026-10-13T12:00:00-04:00", resetAt: "2026-11-11T23:59:59-05:00" },
    { ...sample, used: 4 },
    { ...sample, used: 9, capturedAt: "2026-10-15T12:00:00-04:00" }
  ];
  const markup = graphMarkup(sample, "Cursor Models", history);
  const data = JSON.parse(decodeURIComponent(markup.match(/data-chart="([^"]+)"/)[1]));
  assert.deepEqual(data.actual.map((point) => point.used), [2, 5]);
  assert.equal(data.billingStart, billingPeriod(sample).billingStart);
  assert.equal(data.resetAt, billingPeriod(sample).resetAt);
});

test("150% projection is plotted at 150%, with room above it and accurate zoom labels", () => {
  const nodes = new Map();
  const listeners = {};
  const node = () => ({ style: {}, textContent: "", attrs: {}, children: [], classList: { remove() {} },
    clientWidth: 400, clientHeight: 142, offsetTop: 18,
    setAttribute(key, value) { this.attrs[key] = value; }, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
    addEventListener() {}, getBoundingClientRect() { return { left: 0, width: 400 }; } });
  const chart = { dataset: { chart: encodeURIComponent(JSON.stringify({
    billingStart: new Date("2026-10-11T00:00:00").getTime(), resetAt: new Date("2026-11-11T00:00:00").getTime(),
    now: new Date("2026-10-14T00:00:00").getTime(), projected: 150,
    actual: [{ time: new Date("2026-10-14T00:00:00").getTime(), used: 5.01583 }]
  })) }, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    addEventListener(name, listener) { listeners[name] = listener; } };
  context.document = { body: { append() {} }, createElement: node };
  context.ResizeObserver = class { observe() {} };
  enableChartZoom(chart);
  assert.equal(nodes.get(".cqp-y-max").textContent, "200%");
  assert.ok(nodes.get(".cqp-points").children[0].attrs["aria-label"].endsWith(": 5.01583%"));
  const endpoint = nodes.get(".cqp-line-projection").attrs.d.match(/L([\d.]+) ([\d.]+)/);
  close(Number(endpoint[1]), 400);
  close(Number(endpoint[2]), 35.5); // 150 / 200, not the old 120% clamp.
  close(parseFloat(nodes.get(".cqp-grid-100").style.top), 71);
  assert.equal(nodes.get(".cqp-axis-reset").textContent, "Reset Nov 11");
  listeners.wheel({ preventDefault() {}, deltaX: 0, deltaY: -1, clientX: 200 });
  assert.ok(!nodes.get(".cqp-axis-reset").textContent.startsWith("Reset"));
  assert.ok(!nodes.get(".cqp-axis-start").textContent.startsWith("Start"));
  listeners.dblclick();
  assert.equal(nodes.get(".cqp-axis-reset").textContent, "Reset Nov 11");
});
