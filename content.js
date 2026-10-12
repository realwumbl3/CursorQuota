(() => {
  const STORAGE_KEY = "cursorQuotaPace";
  const CYCLE_DAYS = 30;
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
  const daysFromText = (text) => {
    const match = text.match(/\(([^()]*?)\s+left\)/i);
    if (!match) return NaN;
    const unitDays = { day: 1, hour: 1 / 24, minute: 1 / 1440 };
    const parts = [...match[1].matchAll(/(\d+)\s+(day|hour|minute)s?/gi)];
    return parts.length ? parts.reduce((total, [, count, unit]) => total + Number(count) * unitDays[unit.toLowerCase()], 0) : NaN;
  };
  const resetFromText = (text) => {
    const match = text.match(/reset on ([A-Z][a-z]{2}\s+\d{1,2})/i);
    if (!match) return null;
    const today = new Date();
    let reset = new Date(`${match[1]}, ${today.getFullYear()} 23:59:59`);
    if (reset < today) reset.setFullYear(today.getFullYear() + 1);
    return reset.toISOString();
  };

  function parseSpending() {
    const text = document.body.innerText;
    const daysLeft = daysFromText(text);
    const resetAt = resetFromText(text);
    const meters = {};
    for (const label of ["Cursor Models", "Other Models"]) {
      const labelNode = [...document.querySelectorAll("span")].find((node) => node.textContent.trim() === label);
      const container = labelNode?.closest(".flex.flex-col.gap-1\\.5") || labelNode?.parentElement?.parentElement;
      const used = numberFromText(container?.innerText || "");
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
    const oldestAllowed = now.getTime() - 30 * 24 * 60 * 60 * 1000;
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
  const daysLabel = (value) => `${Math.max(0, Math.ceil(value))} day${Math.ceil(value) === 1 ? "" : "s"}`;

  function metrics(latest, name) {
    const used = latest.meters[name];
    const elapsed = Math.max(1, CYCLE_DAYS - latest.daysLeft);
    const daily = used / elapsed;
    const projected = used + daily * latest.daysLeft;
    const ideal = (elapsed / CYCLE_DAYS) * 100;
    const remainingDaily = (100 - used) / Math.max(1, latest.daysLeft);
    return { used, daily, projected, ideal, remainingDaily, onPace: used <= ideal };
  }

  function graphMarkup(latest, name, history) {
    const m = metrics(latest, name);
    const now = new Date(latest.capturedAt).getTime();
    const resetAt = Math.max(now + 1, new Date(latest.resetAt).getTime());
    const billingStart = resetAt - CYCLE_DAYS * 24 * 60 * 60 * 1000;
    const actual = history
      .filter((entry) => {
        const capturedAt = new Date(entry.capturedAt).getTime();
        return Number.isFinite(entry.used) && capturedAt >= billingStart && capturedAt <= now;
      })
      .map((entry) => ({ time: new Date(entry.capturedAt).getTime(), used: entry.used }))
      .sort((a, b) => a.time - b.time);
    if (!actual.length || actual.at(-1).time !== now) actual.push({ time: now, used: latest.meters[name] });
    const data = encodeURIComponent(JSON.stringify({ actual, now, resetAt, billingStart, projected: m.projected }));
    return `<div class="cqp-chart" data-chart="${data}" role="img" aria-label="${name} usage history and projection for this billing period"><div class="cqp-y-label cqp-y-100">100%</div><div class="cqp-y-label cqp-y-50">50%</div><div class="cqp-plot"><i class="cqp-grid-line cqp-grid-100"></i><i class="cqp-grid-line cqp-grid-50"></i><i class="cqp-grid-line cqp-grid-0"></i><svg class="cqp-series" preserveAspectRatio="none" aria-hidden="true"><path class="cqp-line-actual" fill="none"></path><path class="cqp-line-projection" fill="none"></path></svg></div><div class="cqp-points"></div><div class="cqp-axis"><span class="cqp-axis-start"></span><span class="cqp-axis-today">Today</span><span class="cqp-axis-reset"></span></div><div class="cqp-tooltip" role="tooltip"></div></div>`;
  }

  function enableChartZoom(chart) {
    const data = JSON.parse(decodeURIComponent(chart.dataset.chart));
    const fullRange = data.resetAt - data.billingStart;
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
      const y = (used) => height - (Math.min(120, Math.max(0, used)) / 120) * height;
      const visible = data.actual.filter((point) => point.time >= range.start && point.time <= range.end);
      series.setAttribute("viewBox", `0 0 ${width} ${height}`);
      actualPath.setAttribute("d", data.actual.length > 1 ? pathFrom(data.actual.map((point) => ({ x: x(point.time), y: y(point.used) }))) : "");
      const showProjection = data.resetAt >= range.start && data.now <= range.end;
      projectionPath.setAttribute("class", `cqp-line-projection${data.projected > 100 ? " is-risk" : ""}`);
      projectionPath.setAttribute("d", showProjection ? pathFrom([{ x: x(data.now), y: y(data.actual.at(-1).used) }, { x: x(data.resetAt), y: y(data.projected) }]) : "");
      points.replaceChildren();
      visible.forEach((point) => {
        const dot = document.createElement("i");
        dot.className = "cqp-dom-dot";
        dot.style.left = `${x(point.time)}px`;
        dot.style.top = `${y(point.used)}px`;
        const label = `${new Date(point.time).toLocaleString()}: ${percent(point.used)}`;
        dot.setAttribute("aria-label", label);
        dot.addEventListener("mouseenter", (event) => showTooltip(event, label));
        dot.addEventListener("mousemove", (event) => showTooltip(event, label));
        dot.addEventListener("mouseleave", hideTooltip);
        points.append(dot);
      });
      chart.querySelector(".cqp-axis-start").textContent = `Start ${formatDate(range.start)}`;
      chart.querySelector(".cqp-axis-today").style.left = `${x(data.now)}px`;
      chart.querySelector(".cqp-axis-reset").textContent = `Reset ${formatDate(range.end)}`;
      chart.querySelector(".cqp-y-100").style.top = `${plot.offsetTop + y(100)}px`;
      chart.querySelector(".cqp-y-50").style.top = `${plot.offsetTop + y(50)}px`;
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
      const status = m.projected > 100 ? `Projected to exceed quota by ${percent(m.projected - 100)}` : m.onPace ? "On pace for reset" : "Above your daily pace";
      return `<article class="cqp-meter"><div class="cqp-meter-head"><div><h3>${name}</h3><p>${status}</p></div><strong class="${m.projected > 100 || !m.onPace ? "cqp-warning" : "cqp-good"}">${percent(m.used)} used</strong></div><div class="cqp-stats"><span><b>${percent(m.remainingDaily)}</b> / day remaining</span><span><b>${percent(m.daily)}</b> / day current pace</span><span><b>${percent(m.projected)}</b> projected</span></div>${graphMarkup(latest, name, history)}</article>`;
    }).join("") : "";
    section.innerHTML = `<div class="cqp-header"><div><p class="cqp-eyebrow">CURSORQUOTA</p><h2>Daily budget & reset projection</h2><p class="cqp-subtitle">${latest ? `${daysLabel(latest.daysLeft)} until reset · last updated ${new Date(latest.capturedAt).toLocaleString()}` : "Load your spending data to calculate a projection."}</p></div></div>${latest ? `<div class="cqp-legend"><span class="cqp-key actual"></span>Usage at each visit <span class="cqp-key projected"></span>Projected through reset <span class="cqp-zoom-hint">Scroll to zoom · drag or shift-scroll to pan · double-click to reset</span></div><div class="cqp-meters">${cards}</div>` : ""}`;
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
