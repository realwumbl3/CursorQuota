(() => {
  const STORAGE_KEY = "cursorQuotaPace";
  const CYCLE_DAYS = 30;
  let lastPath = "";
  let renderTimer;
  let activeRender = false;

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
  const daysFromText = (text) => Number((text.match(/\((\d+)\s+days?\s+left\)/i) || [])[1]);
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
    const today = now.toISOString().slice(0, 10);
    const snapshots = store.snapshots || {};
    for (const [name, used] of Object.entries(parsed.meters)) {
      const entries = (snapshots[name] || []).filter((entry) => entry.resetAt === parsed.resetAt && entry.date !== today);
      entries.push({ date: today, capturedAt: now.toISOString(), used, daysLeft: parsed.daysLeft, resetAt: parsed.resetAt });
      snapshots[name] = entries.slice(-45);
    }
    await setStore({ snapshots, latest: { ...parsed, capturedAt: now.toISOString() } });
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

  function graphSvg(latest, name, history) {
    const m = metrics(latest, name);
    const width = 760, height = 190, pad = { left: 34, right: 18, top: 18, bottom: 30 };
    const chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom;
    const elapsed = Math.max(1, CYCLE_DAYS - latest.daysLeft);
    const x = (day) => pad.left + (day / CYCLE_DAYS) * chartW;
    const y = (value) => pad.top + chartH - (Math.min(120, Math.max(0, value)) / 120) * chartH;
    const actual = history.map((entry) => ({ day: Math.max(0, CYCLE_DAYS - entry.daysLeft), used: entry.used }));
    if (!actual.length || actual.at(-1).day !== elapsed) actual.push({ day: elapsed, used: m.used });
    const actualPath = actual.map((point, index) => `${index ? "L" : "M"}${x(point.day).toFixed(1)},${y(point.used).toFixed(1)}`).join(" ");
    const projectedPath = `M${x(elapsed).toFixed(1)},${y(m.used).toFixed(1)} L${x(CYCLE_DAYS).toFixed(1)},${y(m.projected).toFixed(1)}`;
    return `<svg class="cqp-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${name} quota projection"><g class="cqp-grid"><path d="M${pad.left},${y(100)}H${width-pad.right} M${pad.left},${y(50)}H${width-pad.right} M${pad.left},${y(0)}H${width-pad.right}"/></g><path class="cqp-ideal" d="M${x(0)},${y(0)} L${x(CYCLE_DAYS)},${y(100)}"/><path class="cqp-actual" d="${actualPath}"/><path class="cqp-projection ${m.projected > 100 ? "is-risk" : ""}" d="${projectedPath}"/><circle class="cqp-dot" cx="${x(elapsed)}" cy="${y(m.used)}" r="4"/><text x="${pad.left}" y="${height - 8}">Start</text><text x="${x(elapsed)}" y="${height - 8}" text-anchor="middle">Today</text><text x="${width-pad.right}" y="${height - 8}" text-anchor="end">Reset</text><text x="${pad.left - 8}" y="${y(100)+4}" text-anchor="end">100%</text></svg>`;
  }

  function createPanel(latest, store) {
    const section = document.createElement("section");
    section.id = "cursor-quota-pace";
    const cards = latest ? Object.keys(latest.meters).map((name) => {
      const m = metrics(latest, name);
      const history = (store.snapshots?.[name] || []).filter((entry) => entry.resetAt === latest.resetAt);
      const status = m.projected > 100 ? `Projected to exceed quota by ${percent(m.projected - 100)}` : m.onPace ? "On pace for reset" : "Above your daily pace";
      return `<article class="cqp-meter"><div class="cqp-meter-head"><div><h3>${name}</h3><p>${status}</p></div><strong class="${m.projected > 100 || !m.onPace ? "cqp-warning" : "cqp-good"}">${percent(m.used)} used</strong></div><div class="cqp-stats"><span><b>${percent(m.remainingDaily)}</b> / day remaining</span><span><b>${percent(m.daily)}</b> / day current pace</span><span><b>${percent(m.projected)}</b> projected</span></div>${graphSvg(latest, name, history)}</article>`;
    }).join("") : "";
    section.innerHTML = `<div class="cqp-header"><div><p class="cqp-eyebrow">CURSORQUOTA</p><h2>Daily budget & reset projection</h2><p class="cqp-subtitle">${latest ? `${daysLabel(latest.daysLeft)} until reset · last updated ${new Date(latest.capturedAt).toLocaleString()}` : "Load your spending data to calculate a projection."}</p></div></div>${latest ? `<div class="cqp-legend"><span class="cqp-key actual"></span>Actual <span class="cqp-key ideal"></span>Ideal pace <span class="cqp-key projected"></span>Projected</div><div class="cqp-meters">${cards}</div>` : ""}`;
    return section;
  }

  async function renderSpending() {
    if (document.getElementById("cursor-quota-pace")) return;
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
