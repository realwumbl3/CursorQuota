(() => {
  const STORAGE_KEY = "cursorQuotaPace";
  const DAY_MS = 24 * 60 * 60 * 1000;
  let lastPath = "";
  let renderTimer;
  let activeRender = false;
  let spendingVisitCaptured = false;

  const getStore = () => new Promise((resolve) => chrome.storage.local.get(STORAGE_KEY, (value) => resolve(value[STORAGE_KEY] || { snapshots: {} })));
  const setStore = (store) => new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: store }, resolve));
  const waitFor = (check, timeout = 10000) => new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = check();
      if (found || Date.now() - started > timeout) {
        clearInterval(timer);
        resolve(found);
      }
    }, 200);
  });

  const numberFromText = (text) => Number((text.match(/([\d.]+)%\s*used/i) || [])[1]);
  function usageFromContainer(container) {
    const bar = container?.querySelector(".relative.w-full.overflow-hidden > .absolute.inset-y-0.left-0");
    let width = bar?.style.width.trim() || "";
    const variable = width.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (variable) width = getComputedStyle(bar).getPropertyValue(variable[1]).trim();
    // Read the declared percentage, not rendered pixels: min-width can make
    // small usage values look larger than they are. Keep all supplied precision.
    const match = width.match(/^(\d+(?:\.\d+)?|\.\d+)\s*%$/);
    const used = match ? Number(match[1]) : NaN;
    return Number.isFinite(used) ? used : numberFromText(container?.innerText || "");
  }
  const daysFromText = (text) => {
    const match = text.match(/\(([^()]*?)\s+left\)/i);
    if (!match) return NaN;
    const unitDays = { day: 1, hour: 1 / 24, minute: 1 / 1440 };
    const parts = [...match[1].matchAll(/(\d+)\s+(day|hour|minute)s?/gi)];
    return parts.length ? parts.reduce((total, [, count, unit]) => total + Number(count) * unitDays[unit.toLowerCase()], 0) : NaN;
  };
  const resetFromText = (text, today = new Date()) => {
    const match = text.match(/reset on ([A-Z][a-z]{2}\s+\d{1,2})/i);
    if (!match) return null;
    // The page supplies a date, not a reset time. Use local midnight
    // consistently for the estimated monthly cycle and its projection.
    const reset = new Date(`${match[1]}, ${today.getFullYear()} 00:00:00`);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (reset < todayStart) reset.setFullYear(today.getFullYear() + 1);
    if (!Number.isFinite(reset.getTime())) return null;
    return reset.toISOString();
  };

  function billingPeriod(latest) {
    const reset = new Date(latest.resetAt);
    // Normalize older snapshots that stored an invented end-of-day time.
    reset.setHours(0, 0, 0, 0);
    const previousMonthEnd = new Date(reset.getFullYear(), reset.getMonth(), 0).getDate();
    const start = new Date(reset.getFullYear(), reset.getMonth() - 1, Math.min(reset.getDate(), previousMonthEnd));
    const now = new Date(latest.capturedAt).getTime();
    const billingStart = start.getTime();
    const resetAt = reset.getTime();
    return {
      now, billingStart, resetAt,
      elapsedDays: Math.max(0, (now - billingStart) / DAY_MS),
      remainingDays: Math.max(0, (resetAt - now) / DAY_MS)
    };
  }

  function parseSpending() {
    const text = document.body.innerText;
    const daysLeft = daysFromText(text);
    const resetAt = resetFromText(text);
    const meters = {};
    for (const label of ["Cursor Models", "Other Models"]) {
      const labelNode = [...document.querySelectorAll("span")].find((node) => node.textContent.trim() === label);
      const container = labelNode?.closest(".flex.flex-col.gap-1\\.5") || labelNode?.parentElement?.parentElement;
      const used = usageFromContainer(container);
      if (Number.isFinite(used)) meters[label] = used;
    }
    return Number.isFinite(daysLeft) && resetAt && Object.keys(meters).length ? { daysLeft, resetAt, meters } : null;
  }

  async function captureSpending() {
    const parsed = parseSpending();
    if (!parsed) return false;
    const store = await getStore();
    const now = new Date();
    const capturedAt = spendingVisitCaptured ? (store.latest?.capturedAt || now.toISOString()) : now.toISOString();
    const oldestAllowed = now.getTime() - 35 * DAY_MS;
    const snapshots = store.snapshots || {};
    for (const [name, used] of Object.entries(parsed.meters)) {
      const entries = (snapshots[name] || []).filter((entry) => new Date(entry.capturedAt).getTime() >= oldestAllowed);
      if (!spendingVisitCaptured) entries.push({ capturedAt, used, daysLeft: parsed.daysLeft, resetAt: parsed.resetAt });
      snapshots[name] = entries;
    }
    await setStore({ snapshots, latest: { ...parsed, capturedAt } });
    spendingVisitCaptured = true;
    return true;
  }

  const percent = (value) => `${Math.max(0, value).toFixed(1)}%`;
  const usagePercent = (value) => `${Math.max(0, value)}%`;
  const decimalPlaces = (value) => {
    const [coefficient, exponent = "0"] = String(value).split(/e/i);
    return Math.max(0, (coefficient.split(".")[1]?.length || 0) - Number(exponent));
  };
  const quotaUnits = (value, places) => {
    const [coefficient, exponent = "0"] = String(value).split(/e/i);
    const fraction = coefficient.split(".")[1]?.length || 0;
    return BigInt(coefficient.replace(".", "")) * 10n ** BigInt(places + Number(exponent) - fraction);
  };
  const quotaText = (units, places) => {
    const digits = units.toString().padStart(places + 1, "0");
    const fraction = digits.slice(-places).replace(/0+$/, "");
    return `${digits.slice(0, -places)}${fraction ? `.${fraction}` : ""}`;
  };

  function metrics(latest, name) {
    const used = latest.meters[name];
    const period = billingPeriod(latest);
    const daily = period.elapsedDays > 0 ? used / period.elapsedDays : null;
    const projected = daily === null ? null : used + daily * period.remainingDays;
    const remainingDaily = period.remainingDays > 0 ? Math.max(0, 100 - used) / period.remainingDays : null;
    return { used, daily, projected, remainingDaily, period };
  }

  function graphMarkup(latest, name, history) {
    const m = metrics(latest, name);
    const { now, resetAt, billingStart } = m.period;
    const actual = history
      .filter((entry) => {
        const capturedAt = new Date(entry.capturedAt).getTime();
        const entryReset = new Date(entry.resetAt);
        entryReset.setHours(0, 0, 0, 0);
        return Number.isFinite(entry.used) && capturedAt >= billingStart && capturedAt < now && entryReset.getTime() === resetAt;
      })
      .map((entry) => ({ time: new Date(entry.capturedAt).getTime(), used: entry.used }))
      .sort((a, b) => a.time - b.time);
    actual.push({ time: now, used: latest.meters[name] });
    const data = encodeURIComponent(JSON.stringify({ actual, now, resetAt, billingStart, projected: m.projected }));
    return `<div class="cqp-chart" data-chart="${data}" role="img" aria-label="${name} usage history and estimated projection for this billing period"><div class="cqp-y-label cqp-y-max"></div><div class="cqp-y-label cqp-y-100">100%</div><div class="cqp-y-label cqp-y-50">50%</div><div class="cqp-plot"><i class="cqp-grid-line cqp-grid-100"></i><i class="cqp-grid-line cqp-grid-50"></i><i class="cqp-grid-line cqp-grid-0"></i><svg class="cqp-series" preserveAspectRatio="none" aria-hidden="true"><path class="cqp-line-actual" fill="none"></path><path class="cqp-line-projection" fill="none"></path></svg></div><div class="cqp-points"></div><div class="cqp-axis"><span class="cqp-axis-start"></span><span class="cqp-axis-reset"></span></div><div class="cqp-tooltip" role="tooltip"></div></div>`;
  }

  function dailyUsage(latest, name, history) {
    const { now, billingStart, resetAt } = billingPeriod(latest);
    const points = history.filter((entry) => {
      const time = new Date(entry.capturedAt).getTime();
      const reset = new Date(entry.resetAt);
      reset.setHours(0, 0, 0, 0);
      return Number.isFinite(entry.used) && entry.used >= 0 && time >= billingStart && time < now && reset.getTime() === resetAt;
    }).map((entry) => ({ time: new Date(entry.capturedAt).getTime(), used: entry.used }));
    if (!Number.isFinite(now) || now < billingStart || !Number.isFinite(latest.meters[name]) || latest.meters[name] < 0) return [];
    points.push({ time: now, used: latest.meters[name] });
    points.sort((a, b) => a.time - b.time);
    // Prefer newer readings when old counters conflict with them. Never
    // turn a correction or duplicate timestamp into negative daily usage.
    const consistent = [];
    for (let index = points.length - 1; index >= 0; index--) {
      const next = consistent.at(-1);
      if (!next || (points[index].time < next.time && points[index].used <= next.used)) consistent.push(points[index]);
    }
    consistent.reverse();
    const places = Math.max(5, ...consistent.map((point) => decimalPlaces(point.used)));
    const readings = [{ time: billingStart, used: 0, baseline: true }, ...consistent];
    const days = new Map();
    const dayStart = (time) => {
      const date = new Date(time);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    };
    for (let index = 1; index < readings.length; index++) {
      const first = readings[index - 1];
      const last = readings[index];
      const delta = quotaUnits(last.used, places) - quotaUnits(first.used, places);
      const segments = [];
      let cursor = first.time;
      do {
        const start = dayStart(cursor);
        const midnight = new Date(start);
        midnight.setDate(midnight.getDate() + 1);
        const end = Math.min(last.time, midnight.getTime());
        if (!days.has(start)) days.set(start, { start, observed: 0n, estimated: 0n });
        segments.push({ day: days.get(start), duration: BigInt(end - cursor), units: 0n, remainder: 0n });
        cursor = end;
      } while (cursor < last.time);
      const duration = BigInt(last.time - first.time);
      let allocated = 0n;
      for (const segment of segments) {
        segment.units = duration ? delta * segment.duration / duration : delta;
        segment.remainder = duration ? delta * segment.duration % duration : 0n;
        allocated += segment.units;
      }
      // Largest remainders absorb rounding at the captured precision, so
      // every interval and the displayed daily totals reconcile exactly.
      const ranked = [...segments].sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : 0);
      for (let remainder = delta - allocated, i = 0; remainder > 0n; remainder--, i++) ranked[i].units++;
      const measured = !first.baseline && segments.length === 1;
      for (const segment of segments) segment.day[measured ? "observed" : "estimated"] += segment.units;
    }
    return [...days.values()].sort((a, b) => b.start - a.start).map((day) => ({
      start: day.start,
      used: quotaText(day.observed + day.estimated, places),
      observed: quotaText(day.observed, places),
      estimated: quotaText(day.estimated, places)
    }));
  }

  function dailyUsageMarkup(latest, name, history) {
    const days = dailyUsage(latest, name, history);
    if (!days.length) return "";
    const rows = days.map((day) => {
      const date = new Date(day.start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `<li><span>${date}</span><b>${day.used}%</b></li>`;
    }).join("");
    return `<details class="cqp-daily"><summary>Daily usage · ${days[0].used}% on ${new Date(days[0].start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</summary><ul>${rows}</ul></details>`;
  }

  function enableChartZoom(chart) {
    const data = JSON.parse(decodeURIComponent(chart.dataset.chart));
    const fullRange = data.resetAt - data.billingStart;
    const maxUsage = Math.max(100, data.projected ?? 0, ...data.actual.map((point) => point.used));
    const yMax = maxUsage <= 110 ? 120 : Math.ceil(maxUsage * 1.1 / 50) * 50;
    const minimumRange = Math.max(60 * 60 * 1000, fullRange / 8);
    let range = { start: data.billingStart, end: data.resetAt };
    const formatDate = (time) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const tooltip = chart.querySelector(".cqp-tooltip");
    document.body.append(tooltip);
    const hideTooltip = () => tooltip.classList.remove("is-visible");
    const showTooltip = (event, text) => {
      tooltip.textContent = text;
      const margin = 8;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      let left = event.clientX + 14;
      let top = event.clientY - height - 12;
      if (left + width > window.innerWidth - margin) left = event.clientX - width - 14;
      if (left < margin) left = margin;
      if (top < margin) top = Math.min(window.innerHeight - height - margin, event.clientY + 16);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.classList.add("is-visible");
    };
    const pathFrom = (pts) => pts.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    const clampRange = (start, duration) => {
      const nextStart = Math.max(data.billingStart, Math.min(data.resetAt - duration, start));
      return { start: nextStart, end: nextStart + duration };
    };
    const panByPixels = (deltaX) => {
      const width = chart.querySelector(".cqp-plot").clientWidth;
      if (!width || !deltaX) return;
      const duration = range.end - range.start;
      const next = clampRange(range.start - (deltaX / width) * duration, duration);
      if (next.start === range.start) return;
      range = next;
      draw();
    };
    let drag = null;

    const draw = () => {
      const plot = chart.querySelector(".cqp-plot");
      const series = chart.querySelector(".cqp-series");
      const actualPath = chart.querySelector(".cqp-line-actual");
      const projectionPath = chart.querySelector(".cqp-line-projection");
      const points = chart.querySelector(".cqp-points");
      const width = plot.clientWidth;
      const height = plot.clientHeight;
      if (!width || !height) return;
      hideTooltip();
      const x = (time) => ((time - range.start) / (range.end - range.start)) * width;
      const y = (used) => height - (Math.max(0, used) / yMax) * height;
      const visible = data.actual.filter((point) => point.time >= range.start && point.time <= range.end);
      series.setAttribute("viewBox", `0 0 ${width} ${height}`);
      actualPath.setAttribute("d", data.actual.length > 1 ? pathFrom(data.actual.map((point) => ({ x: x(point.time), y: y(point.used) }))) : "");
      const showProjection = data.projected !== null && data.resetAt >= range.start && data.now <= range.end;
      projectionPath.setAttribute("class", `cqp-line-projection${data.projected > 100 ? " is-risk" : ""}`);
      projectionPath.setAttribute("d", showProjection ? pathFrom([{ x: x(data.now), y: y(data.actual.at(-1).used) }, { x: x(data.resetAt), y: y(data.projected) }]) : "");
      points.replaceChildren();
      visible.forEach((point) => {
        const dot = document.createElement("i");
        dot.className = "cqp-dom-dot";
        dot.style.left = `${x(point.time)}px`;
        dot.style.top = `${y(point.used)}px`;
        const label = `${new Date(point.time).toLocaleString()}: ${usagePercent(point.used)}`;
        dot.setAttribute("aria-label", label);
        dot.addEventListener("mouseenter", (event) => showTooltip(event, label));
        dot.addEventListener("mousemove", (event) => showTooltip(event, label));
        dot.addEventListener("mouseleave", hideTooltip);
        points.append(dot);
      });
      chart.querySelector(".cqp-axis-start").textContent = `${range.start === data.billingStart ? "Start " : ""}${formatDate(range.start)}`;
      chart.querySelector(".cqp-axis-reset").textContent = `${range.end === data.resetAt ? "Reset " : ""}${formatDate(range.end)}`;
      chart.querySelector(".cqp-y-max").textContent = `${yMax}%`;
      chart.querySelector(".cqp-y-max").style.top = `${plot.offsetTop}px`;
      chart.querySelector(".cqp-y-100").style.top = `${plot.offsetTop + y(100)}px`;
      chart.querySelector(".cqp-y-50").style.top = `${plot.offsetTop + y(50)}px`;
      chart.querySelector(".cqp-grid-100").style.top = `${y(100)}px`;
      chart.querySelector(".cqp-grid-50").style.top = `${y(50)}px`;
    };

    chart.addEventListener("wheel", (event) => {
      hideTooltip();
      event.preventDefault();
      const plot = chart.querySelector(".cqp-plot");
      const bounds = plot.getBoundingClientRect();
      const horizontal = event.shiftKey ? (event.deltaX || event.deltaY) : event.deltaX;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const line = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.width : 1;
        panByPixels(-horizontal * line);
        return;
      }
      const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const currentDuration = range.end - range.start;
      const nextDuration = Math.max(minimumRange, Math.min(fullRange, currentDuration * (event.deltaY < 0 ? 0.82 : 1.22)));
      const pointerTime = range.start + currentDuration * ratio;
      let start = pointerTime - nextDuration * ratio;
      start = Math.max(data.billingStart, Math.min(data.resetAt - nextDuration, start));
      range = { start, end: start + nextDuration };
      draw();
    }, { passive: false });

    chart.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, panning: false };
      try { chart.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
    });
    chart.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = event.clientX - drag.x;
      if (!drag.panning && Math.abs(delta) < 4) return;
      if (event.pointerType !== "mouse") event.preventDefault();
      drag.panning = true;
      drag.x = event.clientX;
      chart.classList.add("is-panning");
      hideTooltip();
      panByPixels(delta);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      chart.classList.remove("is-panning");
    };
    chart.addEventListener("pointerup", endDrag);
    chart.addEventListener("pointercancel", endDrag);

    chart.addEventListener("dblclick", () => {
      range = { start: data.billingStart, end: data.resetAt };
      draw();
    });
    new ResizeObserver(draw).observe(chart);
    draw();
  }

  function createPanel(latest, store) {
    const section = document.createElement("section");
    section.id = "cursor-quota-pace";
    const cards = latest ? Object.keys(latest.meters).map((name) => {
      const m = metrics(latest, name);
      const history = store.snapshots?.[name] || [];
      const status = m.projected === null ? "Cycle average unavailable at reset" : m.projected > 100 ? `Estimated to exceed quota by ${percent(m.projected - 100)}` : "Within quota at this cycle's average";
      const formatMetric = (value) => value === null ? "—" : percent(value);
      return `<article class="cqp-meter"><div class="cqp-meter-head"><div><h3>${name}</h3><p>${status}</p></div><strong class="${m.projected > 100 || m.used > 100 ? "cqp-warning" : "cqp-good"}">${usagePercent(m.used)} used</strong></div><div class="cqp-stats"><span><b>${formatMetric(m.remainingDaily)}</b> / day budget left</span><span><b>${formatMetric(m.daily)}</b> / day cycle average</span><span><b>${formatMetric(m.projected)}</b> at reset (est.)</span></div>${dailyUsageMarkup(latest, name, history)}${graphMarkup(latest, name, history)}</article>`;
    }).join("") : "";
    section.innerHTML = `<div class="cqp-header"><div><p class="cqp-eyebrow">CURSORQUOTA</p><h2>Daily budget & reset projection</h2><p class="cqp-subtitle">${latest ? `Reset ${new Date(billingPeriod(latest).resetAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · last updated ${new Date(latest.capturedAt).toLocaleString()}` : "Load your spending data to calculate a projection."}</p><p class="cqp-subtitle">Estimates use the monthly cycle average. Reset time is assumed to be midnight.</p></div></div>${latest ? `<div class="cqp-legend"><span class="cqp-legend-item"><i class="cqp-key actual"></i>Usage at each visit</span><span class="cqp-legend-item"><i class="cqp-key projected"></i>Estimated through reset</span><span class="cqp-zoom-hint">Scroll to zoom · drag or shift-scroll to pan · double-click to reset</span></div><div class="cqp-meters">${cards}</div>` : ""}`;
    section.querySelectorAll(".cqp-chart").forEach(enableChartZoom);
    return section;
  }

  async function renderSpending() {
    if (document.getElementById("cursor-quota-pace")) return;
    document.querySelectorAll(".cqp-tooltip").forEach((node) => node.remove());
    const target = await waitFor(() => parseSpending());
    if (!target || location.pathname !== "/dashboard/spending" || document.getElementById("cursor-quota-pace")) return;
    const saved = await captureSpending();
    if (!saved) return;
    const store = await getStore();
    const panel = createPanel(store.latest, store);
    const includedSection = document.getElementById("included-in-pro")?.closest(".dashboard-section");
    if (includedSection) includedSection.before(panel);
  }

  function renderCurrentRoute() {
    if (activeRender) return;
    if (lastPath !== location.pathname) {
      lastPath = location.pathname;
      if (lastPath === "/dashboard/spending") spendingVisitCaptured = false;
      document.querySelectorAll(".cqp-tooltip").forEach((node) => node.remove());
      document.getElementById("cursor-quota-pace")?.remove();
    }
    const render = location.pathname === "/dashboard/spending" ? renderSpending : null;
    if (!render) return;
    activeRender = true;
    render().finally(() => { activeRender = false; });
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderCurrentRoute, 150);
  }

  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", scheduleRender);
  window.addEventListener("hashchange", scheduleRender);
  setInterval(() => {
    const missingCurrentPanel = location.pathname === "/dashboard/spending" && !document.getElementById("cursor-quota-pace");
    if (lastPath !== location.pathname || missingCurrentPanel) scheduleRender();
  }, 1500);
  renderCurrentRoute();
})();
