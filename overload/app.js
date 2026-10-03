/* Overload – Academic Workload Intelligence Platform
 *
 * Everything runs in the browser and is saved to localStorage.
 *
 *   1. Weighted task scoring      -> taskWeight()
 *   2. Effort estimation          -> estimateLocal() / estimateWithAI()
 *   3. Automatic redistribution   -> buildPlan()
 *   4. Workload forecast          -> renderChart() + naivePlan()
 *   5. Check-ins & work log       -> moods[], sessions[]
 *   6. Burnout Risk Index         -> burnoutIndex()
 *   7. Focus timer                -> timer*()
 *   8. Welcome tour               -> tour*()
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
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
    onboarded: false,
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
      const saved = JSON.parse(raw);
      const s = { ...defaultState(), ...saved };
      s.prefs = { ...defaultState().prefs, ...s.prefs };
      if (saved.onboarded === undefined) s.onboarded = s.tasks.length > 0 || s.sessions.length > 0;
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

/* ---------------- Work log ---------------- */
const loggedHours = (taskId) => state.sessions.filter((s) => s.taskId === taskId).reduce((a, s) => a + s.minutes, 0) / 60;
const workedOn = (date) => state.sessions.filter((s) => s.date === date).reduce((a, s) => a + s.minutes, 0) / 60;
const remainingHours = (t) => Math.max(0, t.hours - loggedHours(t.id));
function logSession(taskId, minutes, source, date = todayKey()) {
  if (!(minutes > 0)) return;
  state.sessions.push({ id: uid(), date, taskId: taskId || null, minutes: Math.round(minutes), source });
}
function streak() {
  let k = todayKey(), n = 0;
  if (!(workedOn(k) > 0)) k = addDays(k, -1); // not logging yet today doesn't break the streak
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
      const same = day(k).blocks.find((b) => b.taskId === t.id);
      if (same) { same.hours += remaining; same.forced = true; }
      else day(k).blocks.push({ taskId: t.id, hours: remaining, forced: true });
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

// Suggestions, most urgent first. Each is [level, icon, html].
function suggestions(plan) {
  const out = [];
  const today = todayKey();
  const overdue = state.tasks.filter((t) => !t.done && t.due < today);
  if (overdue.length) out.push(["bad", "i-alert", `<b>${overdue.length} overdue:</b> ${overdue.map((t) => esc(t.title)).join(", ")}. Mark them done or talk to your teacher.`]);
  for (const [id, h] of Object.entries(plan.overflow)) {
    const t = taskById(id);
    out.push(["bad", "i-alert", `<b>${esc(t.title)}</b> needs ${fmtH(h)} more than your limits allow. Start early, raise a daily limit, or ask for help.`]);
  }
  const cl = deadlineClusters()[0];
  if (cl) out.push(["warn", "i-layers", `<b>${cl.count} deadlines</b> between ${prettyDate(cl.start).toLowerCase()} and ${prettyDate(cl.end).toLowerCase()}. Overload moved work earlier. If it's still too much, ask about an extension.`]);
  const recent = state.moods.slice(-3);
  if (recent.length === 3 && recent[2].value >= 4 && recent.every((m, i) => i === 0 || m.value >= recent[i - 1].value))
    out.push(["warn", "i-heart", "Your check-ins are trending toward tired or stressed. Protect your sleep tonight."]);
  const todayMood = state.moods.find((m) => m.date === today);
  if (todayMood && MOOD_CAPACITY[todayMood.value]) out.push(["good", "i-heart", `You're feeling ${MOODS[todayMood.value][1].toLowerCase()}, so today's plan was cut to ${fmtH(capacityFor(today))}.`]);
  if (!todayMood && state.tasks.length) out.push(["", "i-heart", "Check in above. It makes your risk score more accurate."]);
  const rest = [];
  for (let i = 1; i < 7; i++) { const k = addDays(today, i); if (!(plan.days[k]?.load > 0)) rest.push(DAY_FULL[fromKey(k).getDay()]); }
  if (state.tasks.some((t) => !t.done) && rest.length) out.push(["good", "i-leaf", `${rest.slice(0, 2).join(" and ")} ${rest.length === 1 ? "is a free day" : "are free days"}. Use them to recharge.`]);
  return out;
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
  renderTaskSelect();
  renderTimer();
  renderThemeControls();
}

function renderToday(plan, risk) {
  const h = new Date().getHours();
  const hello = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = state.name ? `${hello}, ${state.name}` : hello;
  $("#today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const st = streak();
  $("#streak-pill").innerHTML = `${icon("i-flame", "sm")}${st ? `${st}-day streak` : "No streak yet"}`;

  renderChecklist(plan);
  $("#coming-card").classList.toggle("hidden", !state.tasks.some((t) => !t.done));
  $("#coming-up").innerHTML = deadlineList(4);
  renderCheckin();
  renderRisk(plan, risk);
}

function renderChecklist(plan) {
  const today = todayKey();
  const worked = workedOn(today);
  const blocks = plan.days[today]?.blocks || [];
  const planned = plan.days[today]?.load || worked;
  const left = blocks.reduce((a, b) => a + b.hours, 0);
  const hasOpen = state.tasks.some((t) => !t.done);

  $("#today-sub").textContent = blocks.length
    ? `${blocks.length} thing${blocks.length > 1 ? "s" : ""} to do · about ${fmtH(left)} left`
    : worked > 0 ? "All done for today. Nice work!"
    : hasOpen ? "Nothing planned today. Enjoy the break."
    : "Add your tasks and Overload will plan your days.";
  const pill = $("#today-pill");
  pill.classList.toggle("hidden", !(planned > 0));
  pill.className = `pill ${worked >= planned && planned > 0 ? "good" : "accent"}${planned > 0 ? "" : " hidden"}`;
  pill.textContent = `${fmtH(worked)} of ${fmtH(planned)} done`;
  $("#today-bar").className = `bar today-meter ${worked >= planned && planned > 0 ? "good" : ""}${planned > 0 ? "" : " hidden"}`;
  $("#today-bar").firstElementChild.style.width = `${pct(worked, planned)}%`;

  const rows = blocks.map((b) => {
    const t = taskById(b.taskId);
    return `<div class="todo-row">
      <button class="check" data-check="${t.id}" data-hours="${b.hours}" title="I did this" aria-label="Mark ${esc(t.title)} done for today">${icon("i-check")}</button>
      <div class="t"><b>${dot(t)}<span>${esc(t.title)}</span></b><small>${fmtH(b.hours)} · ${TYPES[t.type].label.toLowerCase()} due ${prettyDate(t.due).toLowerCase()}${b.forced ? " · over your limit" : ""}</small></div>
      <button class="icon-btn play" data-focus="${t.id}" title="Start focus timer" aria-label="Focus on ${esc(t.title)}">${icon("i-play", "sm")}</button>
    </div>`;
  });

  // Work already logged today shows as checked-off rows.
  const byTask = {};
  for (const s of state.sessions.filter((x) => x.date === today)) byTask[s.taskId || ""] = (byTask[s.taskId || ""] || 0) + s.minutes;
  for (const [id, minutes] of Object.entries(byTask)) {
    const t = taskById(id);
    rows.push(`<div class="todo-row done">
      <span class="check on">${icon("i-check")}</span>
      <div class="t"><b>${t ? dot(t) : ""}<span>${esc(t ? t.title : "Other work")}</span></b><small>${fmtH(minutes / 60)} done today</small></div>
      <button class="icon-btn" data-undo="${id}" title="Undo" aria-label="Undo">${icon("i-undo", "sm")}</button>
    </div>`);
  }

  $("#todo").innerHTML = rows.length ? rows.join("") : hasOpen
    ? `<div class="empty">${icon("i-leaf")}Nothing scheduled today. Overload planned your work for other days.</div>`
    : `<div class="empty">Add your tests and assignments, and Overload will build a plan for you.<button class="btn primary" data-new-task>${icon("i-plus")}Add your first task</button></div>`;
}

function renderCheckin() {
  const today = todayKey();
  const todayMood = state.moods.find((m) => m.date === today);
  document.querySelectorAll(".mood").forEach((b) => b.classList.toggle("on", !!todayMood && +b.dataset.mood === todayMood.value));
  $("#checkin-status").textContent = todayMood ? "Checked in ✓" : "";

  // Always 14 cells, so it's never empty, even on day one.
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

  const total = hours.reduce((a, b) => a + b, 0);
  const st = streak();
  $("#hist-summary").textContent = total > 0 ? `${fmtH(total)} worked${st > 1 ? ` · ${st}-day streak` : ""}` : "";

  const inWindow = state.moods.filter((m) => keys.includes(m.date));
  const first = [...state.moods.map((m) => m.date), ...state.sessions.map((s) => s.date)].sort()[0];
  let note;
  if (!first || diffDays(first, today) < 2) {
    note = `${icon("i-sparkle", "sm")}<span>Day one! Check in and tick off your work each day, and your history will fill in here.</span>`;
  } else if (inWindow.length >= 4) {
    const half = Math.floor(inWindow.length / 2);
    const avg = (a) => a.reduce((s, m) => s + m.value, 0) / a.length;
    const delta = avg(inWindow.slice(half)) - avg(inWindow.slice(0, half));
    note = delta > 0.4 ? `${icon("i-alert", "sm")}<span>Your stress has been rising lately. On days you check in tired, your plan gets lighter.</span>`
      : delta < -0.4 ? `${icon("i-heart", "sm")}<span>Your mood is improving. Keep it up.</span>`
      : `${icon("i-heart", "sm")}<span>Your mood has been steady over the last two weeks.</span>`;
  } else {
    note = `${icon("i-sparkle", "sm")}<span>A few more check-ins and Overload can show your stress trend.</span>`;
  }
  $("#hist-note").innerHTML = note;
}

function renderRisk(plan, risk) {
  const lvl = riskLevel(risk.score);
  const C = 2 * Math.PI * 52;
  const arc = $("#risk-arc");
  arc.style.stroke = `var(--${lvl})`;
  arc.style.strokeDashoffset = C * (1 - risk.score / 100);
  $("#risk-score").textContent = risk.score;
  $("#risk-pill").className = `pill ${lvl}`;
  $("#risk-pill").textContent = { good: "Low", warn: "Moderate", bad: "High" }[lvl];
  const hasOpen = state.tasks.some((t) => !t.done);
  $("#risk-title").textContent = !hasOpen ? "Nothing to measure yet" : { good: "Your load is manageable", warn: "Getting heavy", bad: "Burnout warning" }[lvl];
  const top = [...risk.factors].sort((a, b) => b.value * b.w - a.value * a.w)[0];
  $("#risk-summary").textContent = !hasOpen ? "Add tasks and this score will track how heavy your week is."
    : lvl === "good" ? "Stick to the plan and you won't need to cram." : `Biggest factor: ${top.why.charAt(0).toLowerCase() + top.why.slice(1)}.`;
  $("#tips").innerHTML = suggestions(plan).slice(0, 2).map(([cls, ic, text]) => `<li class="${cls}">${icon(ic, "sm")}<span>${text}</span></li>`).join("");
  $("#factors").innerHTML = risk.factors.map((f) => {
    const fl = f.value < 0.4 ? "good" : f.value < 0.7 ? "warn" : "bad";
    return `<div class="factor-row"><b>${f.name}</b><em>${Math.round(f.value * f.w)} / ${f.w}</em>
      <div class="bar ${fl}"><i style="width:${f.value * 100}%"></i></div><span class="why">${esc(f.why)}</span></div>`;
  }).join("");
}

function renderPlan(plan) {
  const today = todayKey();
  const dueOn = {};
  state.tasks.forEach((t) => { if (!t.done) (dueOn[t.due] ||= []).push(t); });

  // Group the next 14 days into "This week" (until Sunday), "Next week", "Later".
  const keys = Array.from({ length: HORIZON }, (_, i) => addDays(today, i));
  const daysToSunday = (7 - fromKey(today).getDay()) % 7;
  const group = (i) => (i <= daysToSunday ? "This week" : i <= daysToSunday + 7 ? "Next week" : "Later");
  const groups = [];
  keys.forEach((k, i) => {
    const g = group(i);
    if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, keys: [] });
    groups[groups.length - 1].keys.push(k);
  });

  const isRest = (k) => !(plan.days[k]?.blocks.length) && !dueOn[k] && !(k === today && workedOn(k) > 0);
  let html = "";
  for (const g of groups) {
    const hours = g.keys.reduce((a, k) => a + (plan.days[k]?.load || 0), 0);
    html += `<div class="week-label"><h2>${g.name}</h2><span class="small faint">${fmtH(hours)} planned</span></div><div class="agenda">`;
    for (let i = 0; i < g.keys.length; i++) {
      const k = g.keys[i];
      if (isRest(k)) {
        // Merge a run of consecutive rest days into one line.
        let j = i;
        while (j + 1 < g.keys.length && isRest(g.keys[j + 1])) j++;
        const a = fromKey(k), b = fromKey(g.keys[j]);
        const label = i === j ? `${DAY_FULL[a.getDay()]} ${a.getDate()}` : `${DAY_NAMES[a.getDay()]} ${a.getDate()} – ${DAY_NAMES[b.getDay()]} ${b.getDate()}`;
        html += `<div class="ag-rest">${icon("i-leaf", "sm")}${label} · ${i === j ? "Rest day" : "Rest days"}</div>`;
        i = j;
        continue;
      }
      const d = plan.days[k] || { load: 0, blocks: [] };
      const c = capacityFor(k);
      const dt = fromKey(k);
      const over = d.load > c + 1e-9;
      const lightened = c < state.capacity[dt.getDay()];
      const name = k === today ? "Today" : diffDays(today, k) === 1 ? "Tomorrow" : DAY_FULL[dt.getDay()];
      const items = [
        ...(dueOn[k] || []).map((t) => `<div class="ag-item due">${dot(t)}<span class="name">${esc(t.title)}</span><span class="tag">Due</span></div>`),
        ...(k === today && workedOn(k) > 0 ? [`<div class="ag-item done">${icon("i-check", "sm")}<span class="name">${fmtH(workedOn(k))} done</span></div>`] : []),
        ...d.blocks.map((b) => {
          const t = taskById(b.taskId);
          return `<div class="ag-item ${b.forced ? "over" : ""}">${dot(t)}<span class="name">${esc(t.title)}</span><span class="hrs">${fmtH(b.hours)}${b.forced ? " · over limit" : ""}</span></div>`;
        }),
      ];
      html += `<div class="ag-day ${k === today ? "today" : ""}">
        <div class="ag-date"><span>${DAY_NAMES[dt.getDay()]}</span><b>${dt.getDate()}</b></div>
        <div class="ag-main">
          <div class="ag-top"><b>${name}</b>
            <span class="ag-load">${fmtH(d.load)} of ${fmtH(c)}<span class="bar ${over ? "bad" : ""}"><i style="width:${c ? pct(d.load, c) : 100}%"></i></span></span></div>
          ${lightened ? `<span class="small faint">Lighter today because you checked in ${MOODS[state.moods.find((m) => m.date === k).value][1].toLowerCase()}.</span>` : ""}
          <div class="ag-items">${items.join("")}</div>
        </div></div>`;
    }
    html += `</div>`;
  }
  if (!state.tasks.some((t) => !t.done)) {
    html = `<div class="card"><div class="empty">${icon("i-calendar")}Your plan will appear here once you add tasks.<button class="btn primary" data-new-task>${icon("i-plus")}Add a task</button></div></div>`;
  }
  $("#agenda").innerHTML = html;

  $("#deadlines").innerHTML = deadlineList(8);
  renderChart(plan);
}

function deadlineList(limit) {
  const today = todayKey();
  const open = state.tasks.filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, limit);
  return open.length
    ? open.map((t) => {
        const days = diffDays(today, t.due);
        const done = t.hours - remainingHours(t);
        return `<div class="dl"><div class="dl-top">${dot(t)}<b>${esc(t.title)}</b>
          <span class="pill ${days < 0 ? "bad" : days <= 1 ? "bad" : days <= 3 ? "warn" : ""}">${days < 0 ? "Overdue" : prettyDate(t.due)}</span></div>
          <small>${TYPES[t.type].label} · ${fmtH(remainingHours(t))} left</small>
          <div class="bar thin ${done >= t.hours ? "good" : ""}"><i style="width:${pct(done, t.hours)}%"></i></div></div>`;
      }).join("")
    : `<div class="empty">No deadlines yet.</div>`;
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
  co.lastElementChild.innerHTML = `Cramming would make your busiest day <b>${fmtH(naivePeak)}</b>. Your plan keeps it to <b>${fmtH(planPeak)}</b>.`;
}

function renderTasks(plan) {
  const showDone = $("#show-done").checked;
  const list = state.tasks.filter((t) => showDone || !t.done).sort((a, b) => a.done - b.done || a.due.localeCompare(b.due));
  $("#task-list").innerHTML = list.length
    ? list.map((t) => {
        const done = t.hours - remainingHours(t);
        return `<div class="task ${t.done ? "done" : ""}">
          <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Mark complete" title="Mark complete" />
          <div>
            <div class="tt">${dot(t)}${esc(t.title)}<span class="pill">${TYPES[t.type].label}</span></div>
            <div class="meta">${t.subject ? esc(t.subject) + " · " : ""}Due ${prettyDate(t.due).toLowerCase()} · ${fmtH(done)} of ${fmtH(t.hours)} done</div>
            <div class="bar ${done >= t.hours ? "good" : ""}"><i style="width:${pct(done, t.hours)}%"></i></div>
            ${plan.overflow[t.id] ? `<div class="warn-line">${icon("i-alert", "sm")}${fmtH(plan.overflow[t.id])} more than your daily limits allow</div>` : ""}
          </div>
          <div class="task-actions">
            ${t.done ? "" : `<button class="icon-btn" data-focus="${t.id}" title="Start focus timer">${icon("i-play", "sm")}</button>`}
            <button class="icon-btn" data-edit="${t.id}" title="Edit">${icon("i-edit", "sm")}</button>
            <button class="icon-btn danger" data-del="${t.id}" title="Delete">${icon("i-trash", "sm")}</button>
          </div></div>`;
      }).join("")
    : `<div class="empty">No tasks yet.<button class="btn primary" data-new-task>${icon("i-plus")}Add your first task</button></div>`;
  $("#subjects").innerHTML = [...new Set(state.tasks.map((t) => t.subject).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join("");
}

function renderTaskSelect() {
  const open = state.tasks.filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const sel = $("#log-task");
  const v = sel.value;
  sel.innerHTML = `<option value="">Something else</option>` + open.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  sel.value = open.some((t) => t.id === v) ? v : "";
}

function renderSettings() {
  if (document.activeElement?.closest("#view-settings")) return; // don't clobber typing
  $("#s-name").value = state.name;
  $("#s-break").value = state.prefs.breakMin;
  $("#s-sound").checked = state.prefs.sound;
  document.querySelectorAll("#s-focus button").forEach((b) => b.classList.toggle("on", +b.dataset.min === state.prefs.focusMin));
  $("#capacity").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((i) => `<label class="field">${DAY_NAMES[i]}<input type="number" min="0" max="12" step="0.5" data-cap="${i}" value="${state.capacity[i]}" /></label>`).join("");
  $("#ai-dot").classList.toggle("on", !!AI_ENDPOINT);
  $("#ai-status").textContent = AI_ENDPOINT ? "Connected. AI estimates are on." : "Not connected yet. Using the built-in estimator.";
}

/* ---------------- 7. Focus timer ---------------- */
// Lives inside the Today card. Stored as timestamps so it keeps time across
// tab switches and reloads.
// timer = { phase: "focus"|"break", taskId, duration (s), left (s), endsAt (ms)|null, started, note }
let tickHandle = null;

function timerLeft() {
  const t = state.timer;
  if (!t) return 0;
  return t.endsAt ? Math.max(0, (t.endsAt - Date.now()) / 1000) : t.left;
}
function openFocus(taskId) {
  if (state.timer?.started && state.timer.phase === "focus") {
    toast("You already have a focus session going.");
  } else {
    const s = state.prefs.focusMin * 60;
    state.timer = { phase: "focus", taskId: taskId || null, duration: s, left: s, endsAt: null, started: false };
    persist(); renderTimer();
  }
  goto("today");
  $("#today-card").scrollIntoView({ behavior: "smooth", block: "start" });
}
function timerStart() {
  const t = state.timer;
  t.started = true;
  t.note = "";
  t.endsAt = Date.now() + t.left * 1000;
  askNotify();
  persist(); renderTimer(); startTicking();
}
function timerPause() {
  const t = state.timer;
  t.left = timerLeft(); t.endsAt = null;
  persist(); renderTimer();
}
// Ends a focus session and saves the time worked. completed = the clock ran out.
function timerFinish(completed) {
  const t = state.timer;
  const elapsed = t.duration - (completed ? 0 : timerLeft());
  if (elapsed < 60) {
    state.timer = null;
    save();
    toast("That was under a minute, so nothing was saved.");
    return;
  }
  const date = completed && t.endsAt ? toKey(new Date(t.endsAt)) : todayKey();
  logSession(t.taskId, elapsed / 60, "timer", date);
  const title = taskById(t.taskId)?.title;
  if (completed) { chime(); notify("Focus session done!", `Nice work. Take a ${state.prefs.breakMin}-minute break.`); }
  const b = state.prefs.breakMin * 60;
  state.timer = { phase: "break", taskId: t.taskId, duration: b, left: b, endsAt: null, started: false,
    note: `Saved ${fmtH(elapsed / 3600)}${title ? ` on ${title}` : ""}. Nice work!` };
  save();
}
function breakDone() {
  chime();
  notify("Break's over", "Ready for the next thing?");
  state.timer = null;
  save();
  toast("Break's over. Ready when you are.");
}
function startTicking() {
  clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    if (!state.timer?.endsAt) { clearInterval(tickHandle); return; }
    if (timerLeft() <= 0) {
      clearInterval(tickHandle);
      state.timer.phase === "focus" ? timerFinish(true) : breakDone();
      return;
    }
    renderTimer();
  }, 500);
}
function renderTimer() {
  const t = state.timer;
  $("#list-mode").classList.toggle("hidden", !!t);
  $("#focus-mode").classList.toggle("hidden", !t);
  document.querySelectorAll("[data-timer-pill]").forEach((p) => {
    p.classList.toggle("hidden", !t?.started);
    if (t?.started) {
      p.classList.toggle("paused", !t.endsAt);
      p.innerHTML = `<span class="dot"></span>${t.phase === "break" ? "Break" : "Focus"} ${fmtClock(Math.ceil(timerLeft()))}`;
    }
  });
  if (!t) { document.title = "Overload"; return; }

  const running = !!t.endsAt;
  const left = timerLeft();
  const isBreak = t.phase === "break";
  $("#focus-label").textContent = isBreak ? "Break time" : t.started ? "Focusing on" : "Ready to focus on";
  $("#focus-title").textContent = isBreak ? "Step away from the screen" : taskById(t.taskId)?.title || "General study";
  $("#focus-len").classList.toggle("hidden", isBreak || t.started);
  document.querySelectorAll("#focus-len button").forEach((b) => b.classList.toggle("on", +b.dataset.min * 60 === t.duration));
  $("#saved-note").classList.toggle("hidden", !t.note);
  $("#saved-note").innerHTML = t.note ? `${icon("i-check", "sm")}${esc(t.note)}` : "";
  $("#timer-time").textContent = fmtClock(Math.ceil(left));
  $("#timer-phase").textContent = isBreak ? (running ? "Break" : t.started ? "Paused" : `${t.duration / 60} min break`) : running ? "Focusing" : t.started ? "Paused" : "Ready";
  $("#timer-ring").classList.toggle("break", isBreak);
  $("#timer-arc").style.strokeDashoffset = 2 * Math.PI * 54 * (1 - left / t.duration);

  const main = $("#timer-main"), second = $("#timer-second"), third = $("#timer-third");
  main.innerHTML = running ? `${icon("i-pause")}Pause` : t.started ? `${icon("i-play")}Resume` : `${icon("i-play")}${isBreak ? "Start break" : "Start"}`;
  if (isBreak) {
    second.innerHTML = t.started ? "Skip break" : "Back to my plan";
  } else {
    second.innerHTML = t.started ? `${icon("i-check")}Done, save time` : "Cancel";
  }
  third.classList.toggle("hidden", isBreak || !t.started);
  third.textContent = "Discard this session";
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

/* ---------------- 8. Welcome tour ---------------- */
let tourStep = 0;
let tourData = {};
const TOUR_STEPS = 5;

function openTour() {
  tourStep = 0;
  tourData = { name: state.name, weekday: state.capacity[1], weekend: state.capacity[6] };
  $("#tour").classList.remove("hidden");
  renderTour();
}
function closeTour(choice) {
  state.name = (tourData.name || "").trim();
  for (const d of [1, 2, 3, 4, 5]) state.capacity[d] = tourData.weekday;
  state.capacity[0] = state.capacity[6] = tourData.weekend;
  state.onboarded = true;
  $("#tour").classList.add("hidden");
  if (choice === "demo") { loadDemo(); goto("today"); toast("Example data loaded. Erase it anytime in Settings."); }
  else if (choice === "task") { save(); openTaskForm(); }
  else { save(); goto("today"); }
}
function renderTour() {
  const body = $("#tour-body");
  const point = (ic, title, text) => `<div class="tour-point"><span class="ic">${ic}</span><div><b>${title}</b><span>${text}</span></div></div>`;
  const steps = [
    () => `<span class="brand-mark tour-hero">${icon("i-bolt")}</span>
      <h2 id="tour-title">Welcome to Overload</h2>
      <p>Overload plans your schoolwork so no single day gets overwhelming, and warns you before burnout hits.</p>
      <div class="tour-points">
        ${point(icon("i-calendar"), "Spreads out your work", "Your study time gets split across the days before each deadline.")}
        ${point(icon("i-shield"), "Warns you early", "A burnout risk score shows when your week is getting too heavy.")}
        ${point(icon("i-heart"), "Checks in on you", "Feeling tired? Your plan gets lighter that day.")}
      </div>`,
    () => `<h2 id="tour-title">What should we call you?</h2>
      <p>Just your first name. It stays on this device.</p>
      <input class="tour-input" id="tour-name" placeholder="Your first name" autocomplete="given-name" maxlength="30" value="${esc(tourData.name)}" />`,
    () => `<h2 id="tour-title">How much can you study in a day?</h2>
      <p>Be realistic and leave time for sleep, sports and friends. Overload will never plan more than this.</p>
      <div class="slider-row"><div class="top">School days <span id="tour-wd-out">${fmtH(tourData.weekday)}</span></div>
        <input type="range" id="tour-wd" min="0.5" max="6" step="0.5" value="${tourData.weekday}" aria-label="Hours on school days" /></div>
      <div class="slider-row"><div class="top">Weekends <span id="tour-we-out">${fmtH(tourData.weekend)}</span></div>
        <input type="range" id="tour-we" min="0" max="8" step="0.5" value="${tourData.weekend}" aria-label="Hours on weekends" /></div>
      <p class="small faint">You can change this per day later in Settings.</p>`,
    () => `<h2 id="tour-title">How it works</h2>
      <div class="tour-points">
        ${point(`<span class="num">1</span>`, "Add your tasks", "Tests, essays and projects, with due dates. Overload estimates how long each takes.")}
        ${point(`<span class="num">2</span>`, "Follow today's plan", "Each day you get a short checklist. Tick things off, or press ▶ to use the focus timer.")}
        ${point(`<span class="num">3</span>`, "Check in daily", "Tap how you feel. Overload watches your stress and workload and warns you before it's too much.")}
      </div>`,
    () => `<h2 id="tour-title">You're all set${tourData.name ? `, ${esc(tourData.name.trim())}` : ""}!</h2>
      <p>Start by adding what's due, or look around with example data first.</p>
      <div class="tour-choices">
        <button class="btn primary lg block" data-tour-end="task">${icon("i-plus")}Add my first task</button>
        <button class="btn soft lg block" data-tour-end="demo">Explore with example data</button>
        <button class="btn ghost block" data-tour-end="empty">Start with an empty plan</button>
      </div>`,
  ];
  body.innerHTML = steps[tourStep]();
  body.style.animation = "none"; void body.offsetWidth; body.style.animation = "";
  $("#tour-dots").innerHTML = Array.from({ length: TOUR_STEPS }, (_, i) => `<i class="${i === tourStep ? "on" : ""}"></i>`).join("");
  const back = $("#tour-back"), next = $("#tour-next");
  back.textContent = tourStep === 0 ? "Skip" : "Back";
  next.classList.toggle("hidden", tourStep === TOUR_STEPS - 1);
  next.textContent = tourStep === 0 ? "Get started" : "Next";

  const name = $("#tour-name");
  if (name) {
    name.addEventListener("input", () => (tourData.name = name.value));
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tourNext(); } });
    setTimeout(() => name.focus(), 50);
  } else {
    setTimeout(() => (tourStep === TOUR_STEPS - 1 ? $("[data-tour-end]") : next).focus(), 50);
  }
  for (const [id, key] of [["tour-wd", "weekday"], ["tour-we", "weekend"]]) {
    const el = $(`#${id}`);
    if (el) el.addEventListener("input", () => { tourData[key] = +el.value; $(`#${id}-out`).textContent = fmtH(+el.value); });
  }
}
function tourNext() { if (tourStep < TOUR_STEPS - 1) { tourStep++; renderTour(); } }
$("#tour-next").addEventListener("click", tourNext);
$("#tour-back").addEventListener("click", () => {
  if (tourStep === 0) closeTour("empty");
  else { tourStep--; renderTour(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#tour").classList.contains("hidden")) closeTour("empty");
});

/* ---------------- Navigation & helpers ---------------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3000);
}
// Two-step confirm inside the page instead of a browser pop-up:
// the first click arms the button, a second click within a few seconds confirms.
function armed(btn, label) {
  if (btn.dataset.armed) { clearTimeout(btn._armT); delete btn.dataset.armed; btn.innerHTML = btn._orig; return true; }
  btn._orig = btn.innerHTML;
  btn.dataset.armed = "1";
  btn.textContent = label;
  btn._armT = setTimeout(() => { delete btn.dataset.armed; btn.innerHTML = btn._orig; }, 3500);
  return false;
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
document.addEventListener("click", (e) => {
  const el = (sel) => e.target.closest(sel);
  if (el(".nav-btn")) return goto(el(".nav-btn").dataset.view);
  if (el("[data-goto]")) { e.preventDefault(); return goto(el("[data-goto]").dataset.goto); }
  if (el("[data-timer-pill]")) { goto("today"); return $("#today-card").scrollIntoView({ behavior: "smooth", block: "start" }); }
  if (el("[data-theme-toggle]")) return setTheme(isDark() ? "light" : "dark");
  if (el("[data-theme-set]")) return setTheme(el("[data-theme-set]").dataset.themeSet);
  if (el("[data-tour-end]")) return closeTour(el("[data-tour-end]").dataset.tourEnd);
  if (el("[data-new-task]")) return openTaskForm();

  const mood = el(".mood");
  if (mood) {
    const date = todayKey(), v = +mood.dataset.mood;
    state.moods = state.moods.filter((m) => m.date !== date);
    state.moods.push({ date, value: v });
    state.moods.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return toast(MOOD_CAPACITY[v] ? "Thanks for being honest. Today's plan is lighter now." : "Check-in saved.");
  }

  if (el("[data-check]")) {
    const b = el("[data-check]");
    logSession(b.dataset.check, +b.dataset.hours * 60, "manual");
    save();
    return toast("Nice! Checked off for today.");
  }
  if (el("[data-undo]")) {
    const id = el("[data-undo]").dataset.undo || null;
    state.sessions = state.sessions.filter((s) => !(s.date === todayKey() && (s.taskId || null) === id));
    save();
    return toast("Undone.");
  }
  if (el("[data-focus]")) return openFocus(el("[data-focus]").dataset.focus);
  if (el("[data-del]")) {
    const id = el("[data-del]").dataset.del;
    if (armed(el("[data-del]"), "Delete?")) { state.tasks = state.tasks.filter((x) => x.id !== id); save(); toast("Task deleted. Plan updated."); }
    return;
  }
  if (el("[data-edit]")) return startEdit(taskById(el("[data-edit]").dataset.edit));

  const chip = el("#log-chips .chip");
  if (chip) {
    document.querySelectorAll("#log-chips .chip").forEach((c) => c.classList.toggle("on", c === chip));
    $("#log-min").value = chip.dataset.m;
    return;
  }
  const len = el("#focus-len button");
  if (len && state.timer && !state.timer.started) {
    state.prefs.focusMin = +len.dataset.min;
    state.timer.duration = state.timer.left = state.prefs.focusMin * 60;
    persist(); renderTimer();
    return;
  }
  const sf = el("#s-focus button");
  if (sf) { state.prefs.focusMin = +sf.dataset.min; save(); }
});

$("#timer-main").addEventListener("click", () => (state.timer.endsAt ? timerPause() : timerStart()));
$("#timer-second").addEventListener("click", () => {
  const t = state.timer;
  if (t.phase === "focus" && t.started) return timerFinish(false);
  state.timer = null; // cancel, back to my plan, or skip break
  save();
});
$("#timer-third").addEventListener("click", (e) => {
  if (!armed(e.currentTarget, "Click again to discard")) return;
  state.timer = null;
  save();
  toast("Session discarded.");
});
$("#focus-general").addEventListener("click", () => openFocus(null));

$("#log-open").addEventListener("click", () => {
  const f = $("#log-form");
  f.classList.toggle("hidden");
  if (!f.classList.contains("hidden")) $("#log-task").focus();
});
$("#log-cancel").addEventListener("click", () => $("#log-form").classList.add("hidden"));
$("#log-min").addEventListener("input", () => document.querySelectorAll("#log-chips .chip").forEach((c) => c.classList.toggle("on", c.dataset.m === $("#log-min").value)));
$("#log-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const minutes = Math.min(600, Math.max(1, parseInt($("#log-min").value, 10) || 0));
  logSession($("#log-task").value || null, minutes, "manual");
  $("#log-form").classList.add("hidden");
  save();
  toast(`Logged ${fmtH(minutes / 60)}. Your plan has been updated.`);
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset.done;
  if (id) {
    const t = taskById(id);
    t.done = e.target.checked;
    save();
    toast(t.done ? "Done! Plan updated." : "Task reopened.");
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
  closeTaskForm();
  save();
  toast(id ? "Task updated. Plan updated." : "Task added. Overload has planned it into your days.");
});

function openTaskForm() {
  resetForm();
  goto("tasks");
  $("#task-form").classList.remove("hidden");
  $("#new-task").classList.add("hidden");
  $("#t-title").focus();
}
function closeTaskForm() {
  resetForm();
  $("#task-form").classList.add("hidden");
  $("#new-task").classList.remove("hidden");
}
function startEdit(t) {
  openTaskForm();
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
  showEstimate("");
}
function resetForm() {
  $("#task-form").reset();
  $("#t-id").value = "";
  $("#t-diff-out").textContent = "3 / 5";
  delete $("#t-hours").dataset.touched;
  $("#t-due").value = addDays(todayKey(), 3);
  $("#form-title").textContent = "New task";
  $("#save-task").lastElementChild.textContent = "Add task";
  autoEstimate();
  showEstimate("");
}
$("#new-task").addEventListener("click", openTaskForm);
$("#cancel-edit").addEventListener("click", closeTaskForm);

/* ---- Data ---- */
function loadDemo() {
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
}
$("#load-demo").addEventListener("click", (e) => {
  if ((state.tasks.length || state.sessions.length) && !armed(e.currentTarget, "Replace my data?")) return;
  loadDemo();
  goto("today");
  toast("Example data loaded.");
});
$("#replay-tour").addEventListener("click", openTour);
$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `overload-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#reset").addEventListener("click", (e) => {
  if (!armed(e.currentTarget, "Click again to erase")) return;
  state = defaultState();
  save();
  toast("Everything erased.");
  openTour();
});

/* ---------------- Boot ---------------- */
resetForm();
render();
goto(location.hash.slice(1) || "today", false);
if (state.timer?.endsAt) {
  if (timerLeft() <= 0) state.timer.phase === "focus" ? timerFinish(true) : breakDone(); // finished while the tab was closed
  else startTicking();
}
if (!state.onboarded) openTour();
// Keep "today" correct if the tab stays open past midnight.
let lastDay = todayKey();
setInterval(() => { if (todayKey() !== lastDay) { lastDay = todayKey(); render(); } }, 60000);
