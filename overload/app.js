/* Overload – Academic Workload Intelligence Platform
 *
 * Everything runs in the browser and is saved to localStorage.
 *
 *   1. Weighted task scoring          -> taskWeight()
 *   2. Effort estimation              -> estimateLocal() / estimateWithAI()
 *   3. Automatic redistribution       -> buildPlan()
 *   4. Workload forecast              -> renderChart() + naivePlan()
 *   5. Stress tracking & work logging -> moods[], sessions[]
 *   6. Burnout Risk Index             -> burnoutIndex()
 *   7. Focus timer                    -> timer*
 */

// URL of the AI proxy (see worker/README.md). Leave empty to use only the
// built-in offline estimator. Your Gemini key lives in the proxy, never here.
const AI_ENDPOINT = "";

const STORAGE_KEY = "overload-v1";
const THEME_KEY = "overload-theme";
const SLOT = 0.5; // scheduler works in half-hour blocks
const HORIZON = 14;

const TYPES = {
  homework: { label: "Homework", weight: 1.0, base: 1 },
  quiz: { label: "Quiz", weight: 1.15, base: 1.5 },
  test: { label: "Test", weight: 1.5, base: 4 },
  essay: { label: "Essay", weight: 1.3, base: 4 },
  project: { label: "Project", weight: 1.4, base: 6 },
  other: { label: "Other", weight: 1.0, base: 1 },
};
const MOODS = { 1: ["🚀", "Great"], 2: ["😊", "Good"], 3: ["😐", "Okay"], 4: ["😴", "Tired"], 5: ["😰", "Stressed"] };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SUBJECT_COLORS = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#0ea5e9", "#ef4444", "#22c55e", "#f97316", "#06b6d4"];

/* ---------------- Date helpers (local time, YYYY-MM-DD) ---------------- */
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);
const todayKey = () => toKey(new Date());
function prettyDate(k) {
  const delta = diffDays(todayKey(), k);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  const d = fromKey(k);
  return `${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
const fmtH = (h) => {
  const m = Math.round(h * 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
};
const fmtClock = (sec) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;

/* ---------------- State ---------------- */
function defaultState() {
  return {
    name: "",
    capacity: [2, 3, 3, 3, 3, 2, 2], // Sun..Sat
    tasks: [],
    moods: [], // { date, value }
    sessions: [], // { id, date, taskId|null, minutes, source: "timer"|"manual" }
    prefs: { focusMin: 25, breakMin: 5, sound: true },
    timer: null,
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = { ...defaultState(), ...JSON.parse(raw) };
      s.prefs = { ...defaultState().prefs, ...s.prefs };
      delete s.geminiKey; delete s.geminiModel; // from v1
      return s;
    }
  } catch (e) { /* storage unavailable or corrupt */ }
  return defaultState();
}
let state = load();
function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
function save() { persist(); render(); }
const uid = () => Math.random().toString(36).slice(2, 10);
const taskById = (id) => state.tasks.find((t) => t.id === id);

/* ---------------- Theme ---------------- */
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
function themePref() { try { return localStorage.getItem(THEME_KEY) || "system"; } catch (e) { return "system"; } }
function isDark() { const p = themePref(); return p === "dark" || (p === "system" && systemDark()); }
function setTheme(pref) {
  try { pref === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pref); } catch (e) { /* ignore */ }
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  renderThemeControls();
}
function renderThemeControls() {
  const dark = isDark();
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    const inTop = b.closest(".topbar");
    b.innerHTML = `<svg class="icon"><use href="#${dark ? "i-sun" : "i-moon"}"/></svg>${inTop ? "" : dark ? "Light mode" : "Dark mode"}`;
    b.title = dark ? "Switch to light mode" : "Switch to dark mode";
  });
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === themePref()));
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", renderThemeControls);

/* ---------------- Work logging ---------------- */
const loggedHours = (taskId) => state.sessions.filter((s) => s.taskId === taskId).reduce((a, s) => a + s.minutes, 0) / 60;
const workedOn = (date) => state.sessions.filter((s) => s.date === date).reduce((a, s) => a + s.minutes, 0) / 60;
const remainingHours = (t) => Math.max(0, t.hours - loggedHours(t.id));
function logSession(taskId, minutes, source, date = todayKey()) {
  if (!(minutes > 0)) return;
  state.sessions.push({ id: uid(), date, taskId: taskId || null, minutes: Math.round(minutes), source });
}
function streak() {
  let k = todayKey(), n = 0;
  if (!(workedOn(k) > 0)) k = addDays(k, -1); // today not logged yet doesn't break the streak
  while (workedOn(k) > 0) { n++; k = addDays(k, -1); }
  return n;
}

/* ---------------- 1. Weighted task scoring ---------------- */
function taskWeight(t) {
  const type = TYPES[t.type] || TYPES.other;
  const diff = 0.6 + t.difficulty * 0.2; // 1→0.8 … 5→1.6
  return type.weight * diff * Math.sqrt(Math.max(t.hours, 0.5));
}
function subjectColor(subject) {
  const s = (subject || "").toLowerCase();
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return s ? SUBJECT_COLORS[h % SUBJECT_COLORS.length] : "var(--text-3)";
}

/* ---------------- 2. Effort estimation ---------------- */
function estimateLocal(type, difficulty, text) {
  const base = (TYPES[type] || TYPES.other).base;
  let hours = base * (0.6 + difficulty * 0.2);
  const reasons = [`${TYPES[type].label.toLowerCase()} baseline`];
  const s = (text || "").toLowerCase();
  const num = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : 0; };

  const pages = num(/(\d+)\s*(?:-|to)?\s*(?:page|pg)/);
  if (pages && (type === "essay" || /write|paper|essay|report/.test(s))) {
    hours = Math.max(hours, pages * 0.9); reasons.push(`${pages} pages to write`);
  } else if (pages) {
    hours += pages * 0.08; reasons.push(`${pages} pages to read`);
  }
  const chapters = s.match(/chapters?\s*(\d+)\s*(?:-|to|through|and|&)\s*(\d+)/);
  if (chapters) {
    const n = Math.abs(+chapters[2] - +chapters[1]) + 1;
    hours += n * 1.2; reasons.push(`${n} chapters`);
  } else if (/chapter/.test(s)) { hours += 1; reasons.push("chapter reading"); }
  const problems = num(/(\d+)\s*(?:problems|questions|exercises)/);
  if (problems) { hours += problems * 0.12; reasons.push(`${problems} problems`); }
  const sources = num(/(\d+)\s*(?:sources|citations|references)/);
  if (sources) { hours += sources * 0.5; reasons.push(`${sources} sources`); }
  const keywords = [
    [/lab report/, 1.5, "lab report"], [/presentation|slides/, 1.5, "presentation"],
    [/research/, 1.5, "research"], [/cumulative|final|midterm/, 3, "cumulative exam"],
    [/group/, 1, "group work"], [/memoriz|vocab/, 0.75, "memorization"],
    [/draft|outline/, 0.75, "drafting"], [/video|record/, 1.5, "media"],
  ];
  for (const [re, add, why] of keywords) if (re.test(s)) { hours += add; reasons.push(why); }

  hours = Math.min(60, Math.max(0.5, Math.round(hours * 2) / 2));
  return { hours, reason: `Quick estimate: ${reasons.join(", ")}.` };
}

async function estimateWithAI(task) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: task.title, type: task.type, difficulty: task.difficulty, desc: task.desc }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
    const hours = Math.min(60, Math.max(0.5, Math.round(Number(data.hours) * 2) / 2));
    if (!isFinite(hours)) throw new Error("unexpected response");
    return { hours, difficulty: data.difficulty, reason: `AI estimate: ${data.reason || ""}` };
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------- Wellness-aware capacity ---------------- */
// Checking in as Tired or Stressed lightens today's limit.
const MOOD_CAPACITY = { 4: 0.75, 5: 0.5 };
function capacityFor(k) {
  const base = state.capacity[fromKey(k).getDay()];
  if (k !== todayKey()) return base;
  const m = state.moods.find((x) => x.date === k);
  return m && MOOD_CAPACITY[m.value] ? Math.floor(base * MOOD_CAPACITY[m.value] * 2) / 2 : base;
}

/* ---------------- 3. Automatic redistribution (scheduler) ---------------- */
// Earliest-deadline-first, and each half-hour block goes to the eligible day
// with the lowest load relative to that day's limit. This flattens peaks
// instead of piling work onto the night before. Time already worked today
// counts toward today's limit. Anything that can't fit is "overflow".
function buildPlan() {
  const today = todayKey();
  const open = state.tasks
    .filter((t) => !t.done && diffDays(today, t.due) >= 0)
    .sort((a, b) => a.due.localeCompare(b.due) || taskWeight(b) - taskWeight(a));

  const days = {};
  const day = (k) => (days[k] ||= { load: 0, blocks: [] });
  day(today).load = workedOn(today);
  const overflow = {};

  for (const t of open) {
    const span = diffDays(today, t.due);
    const lastDay = span === 0 ? 0 : span - 1; // finish the day before it's due
    const eligible = [];
    for (let i = 0; i <= lastDay; i++) eligible.push(addDays(today, i));

    let remaining = remainingHours(t);
    const alloc = {};
    while (remaining > 1e-9) {
      let best = null, bestScore = Infinity;
      for (const k of eligible) {
        const c = capacityFor(k);
        if (c <= 0 || day(k).load + SLOT > c + 1e-9) continue;
        const score = (day(k).load + SLOT) / c + (alloc[k] || 0) * 0.15;
        if (score < bestScore - 1e-9) { bestScore = score; best = k; }
      }
      if (!best) break;
      const chunk = Math.min(SLOT, remaining);
      day(best).load += chunk;
      alloc[best] = (alloc[best] || 0) + chunk;
      remaining -= chunk;
    }
    for (const [k, h] of Object.entries(alloc)) day(k).blocks.push({ taskId: t.id, hours: h });
    if (remaining > 1e-9) {
      overflow[t.id] = remaining;
      const k = eligible[eligible.length - 1];
      day(k).load += remaining;
      day(k).blocks.push({ taskId: t.id, hours: remaining, forced: true });
    }
  }
  return { days, overflow };
}

// What most students do without a plan: everything the day before.
function naivePlan() {
  const today = todayKey();
  const load = {};
  for (const t of state.tasks) {
    if (t.done) continue;
    const span = diffDays(today, t.due);
    if (span < 0) continue;
    const k = addDays(today, Math.max(0, span - 1));
    load[k] = (load[k] || 0) + remainingHours(t);
  }
  return load;
}

/* ---------------- 6. Burnout Risk Index ---------------- */
// 0–100 from five factors, each normalized to 0–1:
//   Weekly load (30) · Busiest day (20) · Deadline pile-up (20)
//   Over your limits (15) · Stress level (15)
function burnoutIndex(plan) {
  const today = todayKey();
  let sum = 0, capSum = 0, peak = 0, peakDay = null;
  for (let i = 0; i < 7; i++) {
    const k = addDays(today, i);
    const l = plan.days[k]?.load || 0;
    const c = capacityFor(k) || 0.5;
    sum += l; capSum += c;
    if (l / c > peak) { peak = l / c; peakDay = k; }
  }
  const sustained = Math.min(1, capSum ? sum / capSum : 0);
  const peakF = Math.min(1, peak / 1.5);
  const clusters = deadlineClusters();
  const clusterF = Math.min(1, (clusters[0]?.weight || 0) / 7);
  const overflowHours = Object.values(plan.overflow).reduce((a, b) => a + b, 0);
  const overflowF = Math.min(1, overflowHours / 6);

  const recent = state.moods.filter((m) => diffDays(m.date, today) < 7).slice(-5).map((m) => m.value);
  let moodF = state.tasks.some((t) => !t.done) ? 0.3 : 0;
  let avgMood = null;
  if (recent.length) {
    avgMood = recent.reduce((a, b) => a + b, 0) / recent.length;
    const slope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / 4 : 0;
    moodF = Math.min(1, Math.max(0, ((avgMood - 1) / 4) * 0.75 + Math.max(0, slope) * 0.5));
  }

  const factors = [
    { name: "Weekly load", value: sustained, w: 30, why: `${fmtH(sum)} of work planned in the next 7 days` },
    { name: "Busiest day", value: peakF, w: 20, why: peakDay && peak > 0 ? `${prettyDate(peakDay)} is at ${Math.round(peak * 100)}% of your limit` : "No heavy days coming up" },
    { name: "Deadline pile-up", value: clusterF, w: 20, why: clusters[0] ? `${clusters[0].count} deadlines within 3 days` : "Deadlines are spread out" },
    { name: "Over your limits", value: overflowF, w: 15, why: overflowHours ? `${fmtH(overflowHours)} of work won't fit` : "Everything fits" },
    { name: "Stress level", value: moodF, w: 15, why: avgMood ? `Recent check-ins average ${MOODS[Math.round(avgMood)][1].toLowerCase()}` : "No check-ins this week" },
  ];
  const score = Math.round(factors.reduce((a, f) => a + f.value * f.w, 0));
  return { score, factors, overflowHours };
}
const riskLevel = (s) => (s < 35 ? "good" : s < 65 ? "warn" : "bad");

function deadlineClusters() {
  const today = todayKey();
  const upcoming = state.tasks.filter((t) => !t.done && diffDays(today, t.due) >= 0 && diffDays(today, t.due) < HORIZON);
  const out = [];
  for (let i = 0; i < HORIZON; i++) {
    const start = addDays(today, i), end = addDays(today, i + 2);
    const inWin = upcoming.filter((t) => t.due >= start && t.due <= end);
    if (inWin.length >= 2) out.push({ start, end, count: inWin.length, weight: inWin.reduce((a, t) => a + taskWeight(t), 0), tasks: inWin });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/* ---------------- Rendering ---------------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, cls = "") => `<svg class="icon ${cls}"><use href="#${id}"/></svg>`;
const dot = (t) => `<span class="subject-dot" style="background:${subjectColor(t?.subject)}"></span>`;
const pct = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);

function render() {
  const plan = buildPlan();
  const risk = burnoutIndex(plan);
  renderToday(plan, risk);
  renderPlan(plan);
  renderTasks(plan);
  renderSettings();
  renderTaskSelects();
  renderTimer();
  renderThemeControls();
}

function renderToday(plan, risk) {
  const h = new Date().getHours();
  const hello = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = state.name ? `${hello}, ${state.name}` : hello;
  $("#today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const st = streak();
  $("#streak-pill").innerHTML = `${icon("i-flame", "sm")}${st ? `${st}-day streak` : "Start a streak today"}`;

  // Risk
  const lvl = riskLevel(risk.score);
  const C = 2 * Math.PI * 52;
  const arc = $("#risk-arc");
  arc.style.stroke = `var(--${lvl})`;
  arc.style.strokeDashoffset = C * (1 - risk.score / 100);
  $("#risk-score").textContent = risk.score;
  $("#risk-pill").className = `pill ${lvl}`;
  $("#risk-pill").textContent = { good: "Low risk", warn: "Moderate risk", bad: "High risk" }[lvl];
  $("#risk-title").textContent = { good: "Your load is sustainable", warn: "Getting heavy", bad: "Burnout warning" }[lvl];
  const top = [...risk.factors].sort((a, b) => b.value * b.w - a.value * a.w)[0];
  $("#risk-summary").textContent = !state.tasks.some((t) => !t.done)
    ? "Add your tasks and Overload will start tracking your workload."
    : lvl === "good" ? "Stick to the plan and you won't need to cram." : `Biggest factor: ${top.name.toLowerCase()}. ${top.why}.`;
  $("#factors").innerHTML = risk.factors.map((f) => {
    const fl = f.value < 0.4 ? "good" : f.value < 0.7 ? "warn" : "bad";
    return `<div class="factor-row"><b>${f.name}</b><em>${Math.round(f.value * f.w)} / ${f.w}</em>
      <div class="bar ${fl}"><i style="width:${f.value * 100}%"></i></div><span class="why">${esc(f.why)}</span></div>`;
  }).join("");

  // Today's work
  const today = todayKey();
  const worked = workedOn(today);
  const todayPlan = plan.days[today] || { load: worked, blocks: [] };
  const planned = todayPlan.load;
  const hero = $("#today-hero");
  hero.className = `today-hero ${worked > 0 ? "done" : ""}`;
  hero.innerHTML = worked > 0
    ? `<div class="badge">${icon("i-check")}</div><div class="t"><b>You worked today. Nice!</b><span class="small muted">${fmtH(worked)} logged${st > 1 ? ` · ${st} days in a row` : ""}</span></div>`
    : `<div class="badge">${icon("i-hand")}</div><div class="t"><b>Did you study today?</b><span class="small muted">Start the timer, or log time you've already done.</span></div>
       <button class="btn good sm" id="quick-log">${icon("i-check", "sm")}I worked today</button>`;
  $("#today-progress-text").textContent = planned > 0 ? `${fmtH(worked)} done of ${fmtH(planned)} planned` : worked > 0 ? `${fmtH(worked)} done` : "Nothing planned today";
  $("#today-progress-pct").textContent = planned > 0 ? `${Math.round(pct(worked, planned))}%` : "";
  $("#today-bar").className = `bar ${worked >= planned && planned > 0 ? "good" : ""}`;
  $("#today-bar").firstElementChild.style.width = `${planned > 0 ? pct(worked, planned) : worked > 0 ? 100 : 0}%`;

  $("#today-blocks").innerHTML = todayPlan.blocks.length
    ? todayPlan.blocks.map((b) => {
        const t = taskById(b.taskId);
        return `<div class="blk">${dot(t)}<div class="t"><b>${esc(t.title)}</b><span>${fmtH(b.hours)} today · due ${prettyDate(t.due).toLowerCase()}${b.forced ? " · over your limit" : ""}</span>
          <div class="bar"><i style="width:${pct(t.hours - remainingHours(t), t.hours)}%"></i></div></div>
          <button class="go" data-focus="${t.id}" title="Focus on this">${icon("i-play", "sm")}</button></div>`;
      }).join("")
    : `<div class="empty">${planned > 0 ? "You've done everything planned for today. Rest up!" : state.tasks.some((t) => !t.done) ? "Nothing scheduled today. Enjoy the break." : "No tasks yet. Add some in Tasks."}</div>`;

  const sess = state.sessions.filter((s) => s.date === today);
  const sl = $("#today-sessions");
  sl.classList.toggle("hidden", !sess.length);
  sl.innerHTML = `<span class="tiny faint">LOGGED TODAY</span>` + sess.map((s) => {
    const t = taskById(s.taskId);
    return `<div class="sess">${icon(s.source === "timer" ? "i-clock" : "i-check", "sm")}<span class="grow">${esc(t ? t.title : "General study")}</span><span>${fmtH(s.minutes / 60)}</span>
      <button class="x-btn" data-del-session="${s.id}" title="Remove">${icon("i-x", "sm")}</button></div>`;
  }).join("");

  renderCheckin();
  renderChart(plan);

  // Upcoming
  const up = state.tasks.filter((t) => !t.done && t.due >= today).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
  $("#upcoming").innerHTML = up.length
    ? up.map((t) => {
        const d = diffDays(today, t.due);
        return `<div class="up">${dot(t)}<div class="t"><b>${esc(t.title)}</b><span>${TYPES[t.type].label} · ${fmtH(remainingHours(t))} left</span></div>
          <span class="pill ${d <= 1 ? "bad" : d <= 3 ? "warn" : ""}">${prettyDate(t.due)}</span></div>`;
      }).join("")
    : `<div class="empty">Nothing due. Add tasks to get started.</div>`;

  $("#insights").innerHTML = insights(plan, risk).map(([cls, ic, text]) => `<li class="${cls}"><span class="ic">${icon(ic, "sm")}</span><span>${text}</span></li>`).join("");
}

function renderCheckin() {
  const today = todayKey();
  const todayMood = state.moods.find((m) => m.date === today);
  document.querySelectorAll(".mood").forEach((b) => b.classList.toggle("on", !!todayMood && +b.dataset.mood === todayMood.value));
  $("#checkin-status").textContent = todayMood ? "Checked in today ✓" : "How are you feeling?";

  // 14-day strip: always 14 cells so it's never empty, even on day one.
  const keys = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
  const hours = keys.map(workedOn);
  const maxH = Math.max(2, ...hours);
  $("#history").innerHTML = keys.map((k, i) => {
    const m = state.moods.find((x) => x.date === k);
    const d = fromKey(k);
    const title = `${prettyDate(k)}: ${m ? MOODS[m.value][1] : "no check-in"}, ${fmtH(hours[i])} worked`;
    return `<div class="hday ${k === today ? "today" : ""}" title="${title}">
      <span class="w">${k === today ? "Today" : DAY_NAMES[d.getDay()][0]}</span>
      <span class="e">${m ? MOODS[m.value][0] : `<span class="ph"></span>`}</span>
      <span class="hb"><i style="height:${(hours[i] / maxH) * 100}%"></i></span>
      <span class="d">${d.getDate()}</span></div>`;
  }).join("");

  const inWindow = state.moods.filter((m) => keys.includes(m.date));
  const avg = inWindow.length ? inWindow.reduce((a, m) => a + m.value, 0) / inWindow.length : null;
  const total = hours.reduce((a, b) => a + b, 0);
  $("#stats").innerHTML = [
    [streak() || 0, "day streak"],
    [`${inWindow.length}/14`, "check-ins"],
    [avg ? MOODS[Math.round(avg)][0] : "–", "average mood"],
    [fmtH(total), "worked"],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");

  let note;
  const first = [...state.moods.map((m) => m.date), ...state.sessions.map((s) => s.date)].sort()[0];
  if (!first || diffDays(first, today) < 2) {
    note = `${icon("i-sparkle", "sm")}<span>Welcome! Check in and log your work each day. Your trend will build up here.</span>`;
  } else if (inWindow.length >= 4) {
    const half = Math.floor(inWindow.length / 2);
    const a = inWindow.slice(0, half), b = inWindow.slice(half);
    const delta = b.reduce((s, m) => s + m.value, 0) / b.length - a.reduce((s, m) => s + m.value, 0) / a.length;
    note = delta > 0.4 ? `${icon("i-alert", "sm")}<span>Your stress has been rising lately. Your plan is lighter on days you check in tired.</span>`
      : delta < -0.4 ? `${icon("i-heart", "sm")}<span>Your mood is improving. Whatever you're doing, keep it up.</span>`
      : `${icon("i-heart", "sm")}<span>Your mood has been steady over the last two weeks.</span>`;
  } else {
    note = `${icon("i-sparkle", "sm")}<span>A few more check-ins and Overload can show your stress trend.</span>`;
  }
  $("#hist-note").innerHTML = note;
  $("#trend-text").textContent = todayMood ? `Today: ${MOODS[todayMood.value][1]}` : "";
}

function renderChart(plan) {
  const naive = naivePlan();
  const today = todayKey();
  const keys = Array.from({ length: HORIZON }, (_, i) => addDays(today, i));
  const maxV = Math.max(4, ...keys.map((k) => Math.max(plan.days[k]?.load || 0, naive[k] || 0, capacityFor(k)))) * 1.08;
  const dueOn = {};
  state.tasks.forEach((t) => { if (!t.done) dueOn[t.due] = (dueOn[t.due] || 0) + 1; });
  $("#chart").innerHTML = keys.map((k, i) => {
    const p = plan.days[k]?.load || 0, n = naive[k] || 0, c = capacityFor(k);
    const d = fromKey(k);
    return `<div class="col ${i === 0 ? "today" : ""}" title="${prettyDate(k)}: ${fmtH(p)} planned, limit ${fmtH(c)}${dueOn[k] ? `, ${dueOn[k]} due` : ""}">
      <div class="bars">
        ${dueOn[k] ? `<span class="due"></span>` : ""}
        <div class="cap" style="bottom:${(c / maxV) * 100}%"></div>
        <div class="b plan ${p > c + 1e-9 ? "over" : ""}" style="height:${(p / maxV) * 100}%"></div>
        <div class="b naive" style="height:${(n / maxV) * 100}%"></div>
      </div>
      <div class="lbl"><b>${DAY_NAMES[d.getDay()][0]}</b>${d.getDate()}</div></div>`;
  }).join("");

  const naivePeak = Math.max(0, ...Object.values(naive));
  const planPeak = Math.max(0, ...keys.map((k) => plan.days[k]?.load || 0));
  const co = $("#callout");
  co.classList.toggle("hidden", !(naivePeak > 0 && planPeak < naivePeak));
  co.lastElementChild.innerHTML = `Cramming would make your busiest day <b>${fmtH(naivePeak)}</b>. With Overload it's <b>${fmtH(planPeak)}</b>, which is <b>${Math.round((1 - planPeak / Math.max(naivePeak, 0.01)) * 100)}% lighter</b>.`;
}

function insights(plan, risk) {
  const out = [];
  const today = todayKey();
  const overdue = state.tasks.filter((t) => !t.done && t.due < today);
  if (overdue.length) out.push(["bad", "i-alert", `<b>${overdue.length} overdue:</b> ${overdue.map((t) => esc(t.title)).join(", ")}. Mark them done or talk to your teacher.`]);

  const cl = deadlineClusters()[0];
  if (cl) out.push(["warn", "i-layers", `<b>Deadline pile-up:</b> ${cl.count} tasks due between ${prettyDate(cl.start)} and ${prettyDate(cl.end)}. Overload has moved work earlier. If it's still too much, ask about an extension.`]);

  for (const [id, h] of Object.entries(plan.overflow)) {
    const t = taskById(id);
    out.push(["bad", "i-alert", `<b>${esc(t.title)}</b> needs ${fmtH(h)} more than your limits allow before ${prettyDate(t.due).toLowerCase()}. Start now, raise a daily limit, or ask for help.`]);
  }

  const recent = state.moods.slice(-3);
  if (recent.length === 3 && recent[2].value >= 4 && recent.every((m, i) => i === 0 || m.value >= recent[i - 1].value))
    out.push(["warn", "i-heart", "Your check-ins are trending toward tired or stressed. Protect your sleep tonight. A rested brain studies faster."]);

  const todayMood = state.moods.find((m) => m.date === today);
  if (todayMood && MOOD_CAPACITY[todayMood.value]) out.push(["good", "i-heart", `You're feeling ${MOODS[todayMood.value][1].toLowerCase()}, so today's limit was lowered to ${fmtH(capacityFor(today))} and the rest was moved to later days.`]);

  const rest = [];
  for (let i = 1; i < 7; i++) { const k = addDays(today, i); if (!(plan.days[k]?.load > 0)) rest.push(prettyDate(k)); }
  if (state.tasks.some((t) => !t.done) && rest.length) out.push(["good", "i-leaf", `<b>Free days:</b> ${rest.slice(0, 3).join(", ")}. Use them to recharge.`]);

  if (!todayMood) out.push(["", "i-hand", "Do today's check-in. It makes your Burnout Risk Index more accurate."]);
  if (!state.tasks.length) out.push(["", "i-sparkle", `Add your first assignment in <a href="#tasks" data-goto="tasks">Tasks</a>, or try the <a href="#settings" data-goto="settings">demo data</a>.`]);
  else if (risk.score < 35 && !out.some((o) => o[0] === "bad")) out.push(["good", "i-check", "Your workload looks sustainable. Follow the plan and you won't have to cram."]);
  return out;
}

function renderPlan(plan) {
  const today = todayKey();
  const dueOn = {};
  state.tasks.forEach((t) => { if (!t.done) (dueOn[t.due] ||= []).push(t); });
  $("#days").innerHTML = Array.from({ length: HORIZON }, (_, i) => addDays(today, i)).map((k) => {
    const d = plan.days[k] || { load: 0, blocks: [] };
    const c = capacityFor(k);
    const worked = k === today ? workedOn(k) : 0;
    const lightened = c < state.capacity[fromKey(k).getDay()];
    const dues = (dueOn[k] || []).map((t) => `<div class="pb due">${dot(t)}<div class="t"><b>Due: ${esc(t.title)}</b><span>${TYPES[t.type].label}</span></div></div>`).join("");
    const doneBlock = worked > 0 ? `<div class="pb done">${icon("i-check", "sm")}<div class="t"><b>${fmtH(worked)} done</b><span>logged today</span></div></div>` : "";
    const blocks = d.blocks.map((b) => {
      const t = taskById(b.taskId);
      return `<div class="pb">${dot(t)}<div class="t"><b>${esc(t.title)}</b><span>${fmtH(b.hours)}${b.forced ? " · over limit" : ""} · due ${prettyDate(t.due).toLowerCase()}</span></div>
        ${k === today ? `<button class="go" data-focus="${t.id}" title="Focus on this">${icon("i-play", "sm")}</button>` : ""}</div>`;
    }).join("");
    const over = d.load > c + 1e-9;
    return `<div class="day ${k === today ? "today" : ""}">
      <div class="day-head"><b>${prettyDate(k)}</b><span class="small faint">${fmtH(d.load)} / ${fmtH(c)}</span></div>
      <div class="bar ${over ? "bad" : ""}"><i style="width:${c ? pct(d.load, c) : d.load ? 100 : 0}%"></i></div>
      ${lightened ? `<span class="note-lite">Lighter today because you checked in ${MOODS[state.moods.find((m) => m.date === k).value][1].toLowerCase()}</span>` : ""}
      ${dues}${doneBlock}${blocks || (dues || doneBlock ? "" : `<div class="rest">${icon("i-leaf", "sm")}Rest day</div>`)}
    </div>`;
  }).join("");
}

function renderTasks(plan) {
  const showDone = $("#show-done").checked;
  const list = state.tasks.filter((t) => showDone || !t.done).sort((a, b) => a.done - b.done || a.due.localeCompare(b.due));
  $("#task-list").innerHTML = list.length
    ? list.map((t) => {
        const done = t.hours - remainingHours(t);
        return `<div class="task ${t.done ? "done" : ""}">
          <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Mark complete" />
          <div>
            <div class="tt">${dot(t)}${esc(t.title)}<span class="pill">${TYPES[t.type].label}</span></div>
            <div class="meta">${t.subject ? esc(t.subject) + " · " : ""}Due ${prettyDate(t.due).toLowerCase()} · ${fmtH(done)} of ${fmtH(t.hours)} done · difficulty ${t.difficulty}/5</div>
            <div class="bar ${done >= t.hours ? "good" : ""}"><i style="width:${pct(done, t.hours)}%"></i></div>
            ${plan.overflow[t.id] ? `<div class="warn-line">${icon("i-alert", "sm")}${fmtH(plan.overflow[t.id])} more than your daily limits allow</div>` : ""}
          </div>
          <div class="task-actions">
            ${t.done ? "" : `<button class="btn ghost sm" data-focus="${t.id}" title="Focus on this">${icon("i-play", "sm")}</button>`}
            <button class="btn ghost sm" data-edit="${t.id}" title="Edit">${icon("i-edit", "sm")}</button>
            <button class="btn ghost sm" data-del="${t.id}" title="Delete">${icon("i-trash", "sm")}</button>
          </div></div>`;
      }).join("")
    : `<div class="empty">No tasks yet. Add your first one above.</div>`;
  $("#subjects").innerHTML = [...new Set(state.tasks.map((t) => t.subject).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join("");
}

function renderTaskSelects() {
  const open = state.tasks.filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const opts = `<option value="">General study</option>` + open.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  for (const sel of [$("#timer-task"), $("#log-task")]) {
    const v = sel === $("#timer-task") && state.timer ? state.timer.taskId || "" : sel.value;
    sel.innerHTML = opts;
    sel.value = open.some((t) => t.id === v) ? v : "";
  }
}

function renderSettings() {
  if (document.activeElement?.closest("#view-settings")) return; // don't clobber typing
  $("#s-name").value = state.name;
  $("#s-break").value = state.prefs.breakMin;
  $("#s-sound").checked = state.prefs.sound;
  $("#capacity").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((i) => `<label class="field">${DAY_NAMES[i]}<input type="number" min="0" max="12" step="0.5" data-cap="${i}" value="${state.capacity[i]}" /></label>`).join("");
  $("#ai-dot").classList.toggle("on", !!AI_ENDPOINT);
  $("#ai-status").textContent = AI_ENDPOINT ? "Connected. AI estimates are on." : "Not connected. Using the built-in estimator.";
}

/* ---------------- 7. Focus timer ---------------- */
// Stored as timestamps so it keeps time across tab switches and reloads.
// timer = { phase: "focus"|"break", taskId, duration (s), endsAt (ms) | null, left (s, when paused) }
let tickHandle = null;

function timerLeft() {
  const t = state.timer;
  if (!t) return state.prefs.focusMin * 60;
  return t.endsAt ? Math.max(0, (t.endsAt - Date.now()) / 1000) : t.left;
}
function timerStart() {
  if (!state.timer) state.timer = { phase: "focus", taskId: $("#timer-task").value || null, duration: state.prefs.focusMin * 60, left: state.prefs.focusMin * 60, endsAt: null };
  const t = state.timer;
  if (t.phase === "focus") t.taskId = $("#timer-task").value || null;
  t.endsAt = Date.now() + t.left * 1000;
  askNotify();
  persist(); renderTimer(); startTicking();
}
function timerPause() {
  const t = state.timer;
  if (!t?.endsAt) return;
  t.left = timerLeft(); t.endsAt = null;
  persist(); renderTimer();
}
function timerFinish(completed) {
  const t = state.timer;
  if (!t) return;
  const elapsed = t.duration - (completed ? 0 : timerLeft());
  let msg = "";
  if (t.phase === "focus" && elapsed >= 60) {
    const date = completed && t.endsAt ? toKey(new Date(t.endsAt)) : todayKey();
    logSession(t.taskId, elapsed / 60, "timer", date);
    msg = `Saved ${fmtH(elapsed / 3600)} of focus${t.taskId && taskById(t.taskId) ? ` on ${taskById(t.taskId).title}` : ""}.`;
  } else if (t.phase === "focus") {
    msg = "Session under a minute, so nothing was saved.";
  }
  if (completed) {
    chime();
    if (t.phase === "focus") {
      notify("Focus session done!", `Nice work. Take a ${state.prefs.breakMin}-minute break.`);
      state.timer = { phase: "break", taskId: t.taskId, duration: state.prefs.breakMin * 60, left: state.prefs.breakMin * 60, endsAt: null };
      msg += " Time for a break.";
    } else {
      notify("Break's over", "Ready for another focus session?");
      state.timer = null;
      msg = "Break's over. Ready when you are.";
    }
  } else {
    state.timer = null;
  }
  save();
  if (msg) toast(msg);
}
function startTicking() {
  clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    if (!state.timer?.endsAt) { clearInterval(tickHandle); return; }
    if (timerLeft() <= 0) { clearInterval(tickHandle); timerFinish(true); return; }
    renderTimer();
  }, 500);
}
function renderTimer() {
  const t = state.timer;
  const running = !!t?.endsAt;
  const left = timerLeft();
  const duration = t ? t.duration : state.prefs.focusMin * 60;
  const isBreak = t?.phase === "break";
  $("#timer-time").textContent = fmtClock(Math.ceil(left));
  $("#timer-phase").textContent = !t ? "Ready to focus" : isBreak ? (running ? "Break" : "Break ready") : running ? "Focusing" : "Paused";
  $("#timer-ring").classList.toggle("break", isBreak);
  const C = 2 * Math.PI * 54;
  $("#timer-arc").style.strokeDashoffset = C * (1 - left / duration);
  $("#timer-main").innerHTML = running ? `${icon("i-pause")}Pause` : t && t.left < t.duration ? `${icon("i-play")}Resume` : `${icon("i-play")}${isBreak ? "Start break" : "Start focus"}`;
  $("#timer-stop").innerHTML = isBreak ? `${icon("i-x")}Skip break` : `${icon("i-check")}Finish &amp; save`;
  $("#timer-stop").disabled = !t;
  $("#timer-task").disabled = !!t && !isBreak;
  document.querySelectorAll("#timer-presets button").forEach((b) => {
    b.disabled = !!t && (running || t.left < t.duration);
    b.classList.toggle("on", b.dataset.break ? isBreak : !isBreak && +b.dataset.min === Math.round(duration / 60));
  });
  const focusedToday = state.sessions.filter((s) => s.date === todayKey() && s.source === "timer");
  const weekStart = addDays(todayKey(), -6);
  const week = state.sessions.filter((s) => s.date >= weekStart && s.source === "timer");
  const longest = Math.max(0, ...state.sessions.filter((s) => s.source === "timer").map((s) => s.minutes));
  const fs = [
    [fmtH(focusedToday.reduce((a, s) => a + s.minutes, 0) / 60), "focused today"],
    [focusedToday.length, focusedToday.length === 1 ? "session today" : "sessions today"],
    [fmtH(week.reduce((a, s) => a + s.minutes, 0) / 60), "focused this week"],
    [fmtH(longest / 60), "longest session"],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  if ($("#focus-stats").innerHTML !== fs) $("#focus-stats").innerHTML = fs;
  $("#timer-note").textContent = focusedToday.length
    ? `${fmtH(focusedToday.reduce((a, s) => a + s.minutes, 0) / 60)} focused today across ${focusedToday.length} session${focusedToday.length > 1 ? "s" : ""}.`
    : "Focus sessions are saved to your work log automatically.";
  document.querySelectorAll("[data-timer-pill]").forEach((p) => {
    p.classList.toggle("hidden", !t || (!running && t.left === t.duration));
    p.classList.toggle("paused", !running);
    p.innerHTML = `<span class="dot"></span>${isBreak ? "Break" : "Focus"} ${fmtClock(Math.ceil(left))}`;
  });
  document.title = running ? `${fmtClock(Math.ceil(left))} · ${isBreak ? "Break" : "Focus"} · Overload` : "Overload";
}

let audioCtx;
function chime() {
  if (!state.prefs.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175, 1568].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t0 = audioCtx.currentTime + i * 0.18;
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 1);
    });
  } catch (e) { /* audio unavailable */ }
}
function askNotify() {
  try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) { /* ignore */ }
}
function notify(title, body) {
  try { if ("Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(title, { body }); } catch (e) { /* ignore */ }
}

/* ---------------- Navigation & toast ---------------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3000);
}
const VIEWS = ["today", "plan", "tasks", "settings"];
function goto(view, push = true) {
  if (!VIEWS.includes(view)) view = "today";
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (push && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", () => goto(location.hash.slice(1), false));

/* ---------------- Events ---------------- */
function focusOn(taskId) {
  if (state.timer && (state.timer.endsAt || state.timer.left < state.timer.duration) && state.timer.phase === "focus") {
    toast("A focus session is already going. Finish it first.");
  } else {
    state.timer = null;
    $("#timer-task").value = taskId;
    timerStart();
    toast(`Focusing on ${taskById(taskId)?.title || "your work"}. You've got this.`);
  }
  goto("today");
  $("#timer-card").scrollIntoView({ behavior: "smooth", block: "center" });
}

document.addEventListener("click", (e) => {
  const el = (sel) => e.target.closest(sel);
  if (el(".nav-btn")) return goto(el(".nav-btn").dataset.view);
  if (el("[data-goto]")) { e.preventDefault(); return goto(el("[data-goto]").dataset.goto); }
  if (el("[data-timer-pill]")) { goto("today"); return $("#timer-card").scrollIntoView({ behavior: "smooth", block: "center" }); }
  if (el("[data-theme-toggle]")) return setTheme(isDark() ? "light" : "dark");
  if (el("[data-theme-set]")) return setTheme(el("[data-theme-set]").dataset.themeSet);

  const mood = el(".mood");
  if (mood) {
    const date = todayKey(), v = +mood.dataset.mood;
    state.moods = state.moods.filter((m) => m.date !== date);
    state.moods.push({ date, value: v });
    state.moods.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return toast(MOOD_CAPACITY[v] ? "Thanks for being honest. Today's plan has been lightened." : "Check-in saved.");
  }

  if (el("#quick-log")) { openLog(); return; }
  if (el("[data-focus]")) return focusOn(el("[data-focus]").dataset.focus);
  if (el("[data-del-session]")) {
    state.sessions = state.sessions.filter((s) => s.id !== el("[data-del-session]").dataset.delSession);
    save(); return toast("Removed from your log.");
  }
  if (el("[data-del]")) {
    const id = el("[data-del]").dataset.del, t = taskById(id);
    if (confirm(`Delete "${t.title}"?`)) { state.tasks = state.tasks.filter((x) => x.id !== id); save(); toast("Task deleted. Plan rebalanced."); }
    return;
  }
  if (el("[data-edit]")) return startEdit(taskById(el("[data-edit]").dataset.edit));

  const chip = el("#log-chips .chip");
  if (chip) {
    document.querySelectorAll("#log-chips .chip").forEach((c) => c.classList.toggle("on", c === chip));
    $("#log-min").value = chip.dataset.m;
    return;
  }
  const preset = el("#timer-presets button");
  if (preset && !preset.disabled) {
    if (preset.dataset.break) {
      const s = +state.prefs.breakMin * 60;
      state.timer = { phase: "break", taskId: null, duration: s, left: s, endsAt: null };
    } else {
      state.prefs.focusMin = +preset.dataset.min;
      state.timer = null;
    }
    persist(); renderTimer();
  }
});

$("#timer-main").addEventListener("click", () => (state.timer?.endsAt ? timerPause() : timerStart()));
$("#timer-stop").addEventListener("click", () => {
  if (state.timer?.phase === "break") { state.timer = null; save(); return; }
  timerFinish(false);
});

function openLog() {
  $("#log-form").classList.remove("hidden");
  $("#log-task").focus();
}
$("#log-open").addEventListener("click", () => ($("#log-form").classList.contains("hidden") ? openLog() : $("#log-form").classList.add("hidden")));
$("#log-cancel").addEventListener("click", () => $("#log-form").classList.add("hidden"));
$("#log-min").addEventListener("input", () => document.querySelectorAll("#log-chips .chip").forEach((c) => c.classList.toggle("on", c.dataset.m === $("#log-min").value)));
$("#log-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const minutes = Math.min(600, Math.max(1, parseInt($("#log-min").value, 10) || 0));
  logSession($("#log-task").value || null, minutes, "manual");
  $("#log-form").classList.add("hidden");
  save();
  toast(`Logged ${fmtH(minutes / 60)}. Nice work! Your plan has been updated.`);
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset.done;
  if (id) {
    const t = taskById(id);
    t.done = e.target.checked;
    save();
    toast(t.done ? "Done! Plan rebalanced." : "Task reopened.");
  }
  if (e.target.id === "show-done") render();
  if (e.target.dataset.cap !== undefined) {
    state.capacity[+e.target.dataset.cap] = Math.max(0, Math.min(12, parseFloat(e.target.value) || 0));
    save();
  }
  if (e.target.id === "s-break") { state.prefs.breakMin = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 5)); save(); }
  if (e.target.id === "s-sound") { state.prefs.sound = e.target.checked; save(); }
});
$("#s-name").addEventListener("input", (e) => { state.name = e.target.value.trim(); persist(); renderToday(buildPlan(), burnoutIndex(buildPlan())); });

/* ---- Task form ---- */
$("#t-diff").addEventListener("input", (e) => { $("#t-diff-out").textContent = `${e.target.value} / 5`; autoEstimate(); });
$("#t-type").addEventListener("change", autoEstimate);
$("#t-hours").addEventListener("input", (e) => (e.target.dataset.touched = "1"));
let descTimer;
$("#t-desc").addEventListener("input", () => { clearTimeout(descTimer); descTimer = setTimeout(autoEstimate, 500); });
$("#t-title").addEventListener("change", autoEstimate);

function readForm() {
  return {
    title: $("#t-title").value.trim(),
    subject: $("#t-subject").value.trim(),
    type: $("#t-type").value,
    due: $("#t-due").value,
    difficulty: +$("#t-diff").value,
    desc: $("#t-desc").value.trim(),
    hours: parseFloat($("#t-hours").value),
  };
}
function showEstimate(text, isError = false) {
  const n = $("#estimate-note");
  n.classList.toggle("hidden", !text);
  n.classList.toggle("err", isError);
  n.innerHTML = text ? `${icon(isError ? "i-alert" : "i-sparkle", "sm")}<span>${esc(text)}</span>` : "";
}
// Live offline estimate while typing, unless the student set the hours themselves.
function autoEstimate() {
  if ($("#t-hours").dataset.touched) return;
  const f = readForm();
  const est = estimateLocal(f.type, f.difficulty, `${f.title} ${f.desc}`);
  $("#t-hours").value = est.hours;
  if (f.desc || f.title) showEstimate(est.reason);
}
$("#estimate-btn").addEventListener("click", async () => {
  const f = readForm();
  delete $("#t-hours").dataset.touched;
  if (!AI_ENDPOINT) {
    autoEstimate();
    showEstimate(`${estimateLocal(f.type, f.difficulty, `${f.title} ${f.desc}`).reason} (AI isn't connected yet.)`);
    return;
  }
  if (!f.title && !f.desc) { showEstimate("Add a title or description first.", true); return; }
  const btn = $("#estimate-btn");
  btn.disabled = true; btn.lastElementChild.textContent = "Thinking…";
  try {
    const est = await estimateWithAI(f);
    $("#t-hours").value = est.hours;
    $("#t-hours").dataset.touched = "1";
    const d = Math.round(est.difficulty);
    if (d >= 1 && d <= 5) { $("#t-diff").value = d; $("#t-diff-out").textContent = `${d} / 5`; }
    showEstimate(est.reason);
  } catch (err) {
    autoEstimate();
    showEstimate(`AI estimate failed (${err.name === "AbortError" ? "timed out" : err.message}). Used the built-in estimate instead.`, true);
  } finally {
    btn.disabled = false; btn.lastElementChild.textContent = "Estimate with AI";
  }
});

$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = readForm();
  if (!(f.hours > 0)) { delete $("#t-hours").dataset.touched; autoEstimate(); f.hours = parseFloat($("#t-hours").value); }
  const id = $("#t-id").value;
  if (id) Object.assign(taskById(id), f);
  else state.tasks.push({ id: uid(), done: false, ...f });
  resetForm();
  save();
  toast(id ? "Task updated. Plan rebalanced." : "Task added. Plan rebalanced.");
});

function startEdit(t) {
  goto("tasks");
  $("#t-id").value = t.id;
  $("#t-title").value = t.title;
  $("#t-subject").value = t.subject || "";
  $("#t-type").value = t.type;
  $("#t-due").value = t.due;
  $("#t-diff").value = t.difficulty;
  $("#t-diff-out").textContent = `${t.difficulty} / 5`;
  $("#t-desc").value = t.desc || "";
  $("#t-hours").value = t.hours;
  $("#t-hours").dataset.touched = "1";
  $("#form-title").textContent = "Edit task";
  $("#save-task").lastElementChild.textContent = "Save changes";
  $("#cancel-edit").classList.remove("hidden");
  showEstimate("");
  $("#t-title").focus();
}
function resetForm() {
  $("#task-form").reset();
  $("#t-id").value = "";
  $("#t-diff-out").textContent = "3 / 5";
  delete $("#t-hours").dataset.touched;
  $("#t-due").value = addDays(todayKey(), 3);
  $("#form-title").textContent = "New task";
  $("#save-task").lastElementChild.textContent = "Add task";
  $("#cancel-edit").classList.add("hidden");
  autoEstimate();
  showEstimate("");
}
$("#cancel-edit").addEventListener("click", resetForm);

/* ---- Data ---- */
$("#load-demo").addEventListener("click", () => {
  if ((state.tasks.length || state.sessions.length) && !confirm("Replace your current tasks, check-ins and work log with demo data?")) return;
  const t = todayKey();
  const mk = (title, subject, type, dueIn, difficulty, hours, desc = "") => ({ id: uid(), done: false, title, subject, type, due: addDays(t, dueIn), difficulty, hours, desc });
  state.tasks = [
    mk("Derivatives test", "AP Calculus", "test", 3, 4, 5),
    mk("Chemistry quiz", "Chemistry", "quiz", 4, 3, 2),
    mk("Spanish vocab ch. 5", "Spanish", "homework", 2, 2, 1),
    mk("Great Gatsby essay", "English", "essay", 5, 4, 5, "Write a 5 page analysis with at least 3 sources."),
    mk("APUSH reading ch. 9-10", "APUSH", "homework", 6, 3, 3),
    mk("Physics lab report", "Physics", "project", 9, 3, 4, "Lab report with graphs"),
    mk("Bio unit test", "Biology", "test", 11, 4, 5),
  ];
  const moods = [2, 2, 3, 2, 3, 3, 4, 3, 2, 3, 4, 3];
  state.moods = moods.map((value, i) => ({ date: addDays(t, i - moods.length), value }));
  const worked = [60, 90, 0, 45, 120, 30, 0, 75, 60, 90, 0, 45, 105];
  state.sessions = worked.flatMap((m, i) => (m ? [{ id: uid(), date: addDays(t, i - worked.length), taskId: null, minutes: m, source: i % 2 ? "timer" : "manual" }] : []));
  state.timer = null;
  if (!state.name) state.name = "Alex";
  save();
  goto("today");
  toast("Demo data loaded.");
});
$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `overload-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#reset").addEventListener("click", () => {
  if (!confirm("Erase all tasks, check-ins, work logs and settings on this device?")) return;
  state = defaultState();
  save();
  toast("Everything erased.");
});

/* ---------------- Boot ---------------- */
resetForm();
render();
goto(location.hash.slice(1) || "today", false);
if (state.timer?.endsAt) {
  if (timerLeft() <= 0) timerFinish(true); // finished while the tab was closed
  else startTicking();
}
// Keep "today" correct if the tab stays open past midnight.
let lastDay = todayKey();
setInterval(() => { if (todayKey() !== lastDay) { lastDay = todayKey(); render(); } }, 60000);
