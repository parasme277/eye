/* Overload – Academic Workload Intelligence Platform
 *
 * Everything runs in the browser. Data is saved to localStorage.
 *
 * Core pieces:
 *   1. Weighted task scoring        -> taskWeight()
 *   2. Effort estimation            -> estimateLocal() / estimateWithGemini()
 *   3. Automatic redistribution     -> buildPlan()  (load-balancing scheduler)
 *   4. Workload intensity forecast  -> dailyLoad() + naivePlan() comparison
 *   5. Stress trend tracking        -> mood check-ins
 *   6. Burnout Risk Index           -> burnoutIndex()
 */

const STORAGE_KEY = "overload-v1";
const SLOT = 0.5; // scheduler works in half-hour blocks
const HORIZON = 14; // days shown in the forecast

const TYPES = {
  homework: { label: "Homework", weight: 1.0, base: 1, emoji: "📝" },
  quiz: { label: "Quiz", weight: 1.15, base: 1.5, emoji: "✏️" },
  test: { label: "Test", weight: 1.5, base: 4, emoji: "📚" },
  essay: { label: "Essay", weight: 1.3, base: 4, emoji: "🖋️" },
  project: { label: "Project", weight: 1.4, base: 6, emoji: "🛠️" },
  other: { label: "Other", weight: 1.0, base: 1, emoji: "📌" },
};
const MOODS = { 1: "🚀", 2: "😊", 3: "😐", 4: "😴", 5: "😰" };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------------- Date helpers (local time, YYYY-MM-DD) ---------------- */
function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(k, n) {
  const d = fromKey(k);
  d.setDate(d.getDate() + n);
  return toKey(d);
}
function diffDays(a, b) {
  return Math.round((fromKey(b) - fromKey(a)) / 86400000);
}
const todayKey = () => toKey(new Date());
function prettyDate(k) {
  const d = fromKey(k);
  const delta = diffDays(todayKey(), k);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  return `${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
const fmtH = (h) => (Math.round(h * 10) / 10).toString().replace(/\.0$/, "") + "h";

/* ---------------- State ---------------- */
let state = load();

function defaultState() {
  return {
    name: "",
    capacity: [2, 3, 3, 3, 3, 2, 2], // Sun..Sat max study hours
    tasks: [],
    moods: [], // { date, value }
    geminiKey: "",
    geminiModel: "gemini-2.5-flash",
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { /* storage unavailable or corrupt */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  render();
}
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- 1. Weighted task scoring ---------------- */
// Weight = type importance × difficulty multiplier × size (hours, dampened).
function taskWeight(t) {
  const type = TYPES[t.type] || TYPES.other;
  const diff = 0.6 + t.difficulty * 0.2; // 1→0.8 … 5→1.6
  return type.weight * diff * Math.sqrt(Math.max(t.hours, 0.5));
}

/* ---------------- 2. Effort estimation ---------------- */
function estimateLocal(type, difficulty, text) {
  const base = (TYPES[type] || TYPES.other).base;
  let hours = base * (0.6 + difficulty * 0.2);
  const reasons = [`${TYPES[type].label} baseline`];
  const s = (text || "").toLowerCase();
  const num = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : 0; };

  const pages = num(/(\d+)\s*(?:-|to)?\s*(?:page|pg)/);
  if (pages && (type === "essay" || /write|paper|essay|report/.test(s))) {
    hours = Math.max(hours, pages * 0.9); reasons.push(`${pages} pages to write`);
  } else if (pages) {
    hours += pages * 0.08; reasons.push(`${pages} pages to read`);
  }
  const chapters = s.match(/chapters?\s*(\d+)\s*(?:-|to|through)\s*(\d+)/);
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
    [/group/, 1, "group coordination"], [/memoriz|vocab/, 0.75, "memorization"],
    [/draft|outline/, 0.75, "drafting"], [/video|record/, 1.5, "media production"],
  ];
  for (const [re, add, why] of keywords) if (re.test(s)) { hours += add; reasons.push(why); }

  hours = Math.min(60, Math.max(0.5, Math.round(hours * 2) / 2));
  return { hours, reason: reasons.join(" · ") };
}

async function estimateWithGemini(task) {
  const model = state.geminiModel || "gemini-2.5-flash";
  const prompt =
    `You estimate homework workload for a US high school student.\n` +
    `Assignment type: ${task.type}. Self-rated difficulty: ${task.difficulty}/5.\n` +
    `Title: ${task.title}\nDescription: ${task.desc || "(none)"}\n` +
    `Reply ONLY with JSON: {"hours": <number of focused hours needed>, "difficulty": <1-5>, "reason": "<one short sentence>"}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": state.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const out = JSON.parse(text.replace(/```json|```/g, "").trim());
  const hours = Math.min(60, Math.max(0.5, Math.round(Number(out.hours) * 2) / 2));
  if (!isFinite(hours)) throw new Error("Bad response");
  return { hours, difficulty: out.difficulty, reason: `Gemini: ${out.reason || ""}` };
}

/* ---------------- Wellness-aware capacity ---------------- */
// If today's check-in is "Tired" or "Overwhelmed", Overload lightens today's
// limit and pushes the difference onto later days.
const MOOD_CAPACITY = { 4: 0.75, 5: 0.5 };
function capacityFor(k) {
  const base = state.capacity[fromKey(k).getDay()];
  if (k !== todayKey()) return base;
  const m = state.moods.find((x) => x.date === k);
  return m && MOOD_CAPACITY[m.value] ? Math.floor(base * MOOD_CAPACITY[m.value] * 2) / 2 : base;
}

/* ---------------- 3. Automatic redistribution (scheduler) ---------------- */
// Greedy load balancer: tasks are processed earliest-deadline-first, and each
// half-hour block goes to the eligible day with the lowest load relative to
// that day's capacity. This flattens peaks instead of piling work on the
// night before. Anything that cannot fit under capacity is reported as
// overflow – a key burnout signal.
function buildPlan() {
  const today = todayKey();
  const open = state.tasks
    .filter((t) => !t.done && diffDays(today, t.due) >= 0)
    .sort((a, b) => a.due.localeCompare(b.due) || taskWeight(b) - taskWeight(a));

  const days = {}; // key -> { load, blocks: [{taskId, hours}] }
  const day = (k) => (days[k] ||= { load: 0, blocks: [] });
  const cap = (k) => capacityFor(k);
  const overflow = {};

  for (const t of open) {
    const left = Math.max(0, t.hours - (t.doneHours || 0));
    const span = diffDays(today, t.due);
    // Work happens on days before the due date; if it's due today, today is the only option.
    const lastDay = span === 0 ? 0 : span - 1;
    const eligible = [];
    for (let i = 0; i <= lastDay; i++) eligible.push(addDays(today, i));

    let remaining = left;
    const alloc = {};
    while (remaining > 1e-9) {
      let best = null, bestScore = Infinity;
      for (const k of eligible) {
        const c = cap(k);
        if (c <= 0 || day(k).load + SLOT > c + 1e-9) continue;
        // Prefer less-loaded days; slight preference for spreading the same task out.
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
      // Unfittable work still has to happen – put it on the last possible day so it shows up as overload.
      const k = eligible[eligible.length - 1];
      day(k).load += remaining;
      day(k).blocks.push({ taskId: t.id, hours: remaining, forced: true });
    }
  }
  return { days, overflow };
}

// What a typical student does without Overload: all the work the day before.
function naivePlan() {
  const today = todayKey();
  const load = {};
  for (const t of state.tasks) {
    if (t.done) continue;
    const span = diffDays(today, t.due);
    if (span < 0) continue;
    const k = addDays(today, Math.max(0, span - 1));
    load[k] = (load[k] || 0) + Math.max(0, t.hours - (t.doneHours || 0));
  }
  return load;
}

/* ---------------- 6. Burnout Risk Index ---------------- */
// 0–100. Five weighted factors, each normalized to 0–1:
//   Sustained load   (30) – average planned hours / capacity over next 7 days
//   Peak pressure    (20) – heaviest day vs. its capacity
//   Deadline cluster (20) – most weighted deadlines inside any 3-day window
//   Overflow         (15) – hours that can't fit under capacity at all
//   Stress trend     (15) – recent mood level + whether it is getting worse
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

  const recent = state.moods.slice(-5).map((m) => m.value);
  let moodF = state.tasks.some((t) => !t.done) ? 0.3 : 0; // unknown mood = mild assumption
  if (recent.length) {
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const level = (avg - 1) / 4;
    const slope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / 4 : 0;
    moodF = Math.min(1, Math.max(0, level * 0.75 + Math.max(0, slope) * 0.5));
  }

  const factors = [
    { name: "Sustained load", value: sustained, w: 30, text: `${fmtH(sum)} planned this week` },
    { name: "Peak day", value: peakF, w: 20, text: peakDay && peak > 0 ? `${Math.round(peak * 100)}% of limit (${prettyDate(peakDay)})` : "No heavy days" },
    { name: "Deadline clustering", value: clusterF, w: 20, text: clusters[0] ? `${clusters[0].count} due within 3 days` : "Spread out" },
    { name: "Over capacity", value: overflowF, w: 15, text: overflowHours ? `${fmtH(overflowHours)} won't fit` : "Everything fits" },
    { name: "Stress trend", value: moodF, w: 15, text: recent.length ? `Recent mood ${MOODS[Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)]}` : "No check-ins yet" },
  ];
  const score = Math.round(factors.reduce((a, f) => a + f.value * f.w, 0));
  return { score, factors, overflowHours, peakDay, peak };
}

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
const taskById = (id) => state.tasks.find((t) => t.id === id);

function render() {
  const plan = buildPlan();
  const risk = burnoutIndex(plan);
  renderDashboard(plan, risk);
  renderPlan(plan);
  renderTasks(plan);
  renderSettings();
}

function renderDashboard(plan, risk) {
  $("#welcome").textContent = state.name ? `Welcome back, ${state.name} 👋` : "Welcome to Overload 👋";

  const el = $("#score-value");
  el.textContent = `${risk.score}%`;
  el.className = "score-value " + (risk.score < 35 ? "low" : risk.score < 65 ? "mod" : "");
  $("#score-label").textContent = risk.score < 35 ? "✅ Low Risk" : risk.score < 65 ? "⚠️ Moderate Risk" : "🔥 High Risk";
  const fill = $("#meter-fill");
  fill.style.width = `${Math.max(2, risk.score)}%`;
  fill.style.backgroundSize = `${(100 / Math.max(risk.score, 1)) * 100}% 100%`;
  $("#factors").innerHTML = risk.factors
    .map((f) => `<div class="factor" title="${f.w} points max"><div class="f-top"><b>${f.name}</b><em>${Math.round(f.value * f.w)}/${f.w}</em></div><span>${esc(f.text)}</span></div>`)
    .join("");

  // Mood
  const todayMood = state.moods.find((m) => m.date === todayKey());
  document.querySelectorAll(".mood").forEach((b) => b.classList.toggle("selected", !!todayMood && +b.dataset.mood === todayMood.value));
  renderTrend();

  // Load chart
  const naive = naivePlan();
  const today = todayKey();
  const keys = Array.from({ length: HORIZON }, (_, i) => addDays(today, i));
  const maxV = Math.max(4, ...keys.map((k) => Math.max(plan.days[k]?.load || 0, naive[k] || 0, capacityFor(k))));
  const dueOn = {};
  state.tasks.forEach((t) => { if (!t.done) dueOn[t.due] = (dueOn[t.due] || 0) + 1; });
  $("#load-chart").innerHTML = keys
    .map((k, i) => {
      const p = plan.days[k]?.load || 0, n = naive[k] || 0, c = capacityFor(k);
      const d = fromKey(k);
      return `<div class="bar-col ${i === 0 ? "today" : ""}" title="${prettyDate(k)}: ${fmtH(p)} planned (limit ${fmtH(c)})${dueOn[k] ? ` · ${dueOn[k]} due` : ""}">
        ${dueOn[k] ? `<span class="dot">📌</span>` : ""}
        <div class="bar-stack">
          <div class="cap-line" style="bottom:${(c / maxV) * 100}%"></div>
          <div class="bar plan ${p > c + 1e-9 ? "over" : ""}" style="height:${(p / maxV) * 100}%"></div>
          <div class="bar naive" style="height:${(n / maxV) * 100}%"></div>
        </div>
        <div class="bar-label"><b>${DAY_NAMES[d.getDay()][0]}</b>${d.getDate()}</div>
      </div>`;
    })
    .join("");

  const naivePeak = Math.max(0, ...Object.values(naive));
  const planPeak = Math.max(0, ...keys.map((k) => plan.days[k]?.load || 0));
  $("#compare").innerHTML =
    naivePeak > 0 && planPeak < naivePeak
      ? `📉 Cramming the night before would put your busiest day at <b>${fmtH(naivePeak)}</b>. Overload's plan caps it at <b>${fmtH(planPeak)}</b>, which is <b>${Math.round((1 - planPeak / naivePeak) * 100)}% lighter</b>.`
      : "";

  // Upcoming
  const up = state.tasks.filter((t) => !t.done && t.due >= today).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5);
  const colors = ["#a855f7", "#22c55e", "#f59e0b", "#2f6fea", "#ef4444"];
  $("#upcoming").innerHTML = up.length
    ? up.map((t, i) => `<div class="up-item" style="border-left-color:${colors[i % colors.length]}">
        <div><b>${esc(t.title)}</b><span>${prettyDate(t.due)} · ${fmtH(t.hours)}</span></div>
        <div class="emoji">${TYPES[t.type]?.emoji || "📌"}</div></div>`).join("")
    : `<div class="empty">Nothing due. Add tasks in the <a href="#" data-goto="tasks">Tasks</a> tab.</div>`;

  // Insights
  $("#insights").innerHTML = insights(plan, risk).map(([cls, icon, text]) => `<li class="${cls}"><span>${icon}</span><span>${text}</span></li>`).join("");
}

function renderTrend() {
  const pts = state.moods.slice(-14);
  const svg = $("#trend");
  if (pts.length < 2) {
    svg.innerHTML = `<text x="150" y="35" text-anchor="middle" font-size="11" fill="#94a3b8">Check in a few days to see your trend</text>`;
    $("#trend-text").textContent = "";
    return;
  }
  const x = (i) => 6 + (i / (pts.length - 1)) * 288;
  const y = (v) => 54 - ((v - 1) / 4) * 48; // higher on the chart = more stress
  const line = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  svg.innerHTML =
    `<polyline points="${line}" fill="none" stroke="#2f6fea" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.value)}" r="3" fill="${p.value >= 4 ? "#ef4444" : "#2f6fea"}"/>`).join("");
  const first = pts.slice(0, Math.ceil(pts.length / 2)), second = pts.slice(Math.floor(pts.length / 2));
  const avg = (a) => a.reduce((s, p) => s + p.value, 0) / a.length;
  const delta = avg(second) - avg(first);
  $("#trend-text").textContent = delta > 0.4 ? "📈 Stress rising" : delta < -0.4 ? "📉 Stress easing" : "➡️ Steady";
}

function insights(plan, risk) {
  const out = [];
  const today = todayKey();
  const overdue = state.tasks.filter((t) => !t.done && t.due < today);
  if (overdue.length) out.push(["bad", "⏰", `${overdue.length} task${overdue.length > 1 ? "s are" : " is"} past due: ${overdue.map((t) => esc(t.title)).join(", ")}. Mark them done or talk to your teacher.`]);

  const cl = deadlineClusters()[0];
  if (cl) out.push(["warn", "🧱", `Deadline cluster: <b>${cl.count} tasks</b> due between ${prettyDate(cl.start)} and ${prettyDate(cl.end)} (${cl.tasks.map((t) => esc(t.title)).join(", ")}). Overload has front-loaded the work; if it's still too much, consider asking a teacher for an extension.`]);

  for (const [id, h] of Object.entries(plan.overflow)) {
    const t = taskById(id);
    out.push(["bad", "🚨", `<b>${esc(t.title)}</b> needs ${fmtH(h)} more than your daily limits allow before ${prettyDate(t.due)}. Raise your limit for a day, start smaller pieces now, or ask for help.`]);
  }

  const recent = state.moods.slice(-3);
  if (recent.length === 3 && recent.every((m, i) => i === 0 || m.value >= recent[i - 1].value) && recent[2].value >= 4)
    out.push(["warn", "💙", "Your check-ins have trended toward tired/overwhelmed. Protect your sleep tonight. A rested brain studies faster than a tired one."]);

  const rest = [];
  for (let i = 0; i < 7; i++) {
    const k = addDays(today, i);
    if (!(plan.days[k]?.load > 0)) rest.push(prettyDate(k));
  }
  if (state.tasks.some((t) => !t.done) && rest.length) out.push(["good", "🌿", `Free days this week: ${rest.slice(0, 3).join(", ")}. Use them to recharge, not to catch up.`]);

  if (!state.moods.find((m) => m.date === today)) out.push(["", "👆", "Do your daily mood check-in above. It makes your Burnout Risk Index more accurate."]);

  if (risk.score < 35 && state.tasks.some((t) => !t.done)) out.push(["good", "✅", "Your workload looks sustainable. Stick to the plan and you won't have to cram."]);
  if (!state.tasks.length) out.push(["", "🚀", `Add your first assignment in <a href="#" data-goto="tasks">Tasks</a>, or load demo data in <a href="#" data-goto="settings">Settings</a>.`]);
  return out;
}

function renderPlan(plan) {
  const today = todayKey();
  const dueOn = {};
  state.tasks.forEach((t) => { if (!t.done) (dueOn[t.due] ||= []).push(t); });
  $("#week").innerHTML = Array.from({ length: HORIZON }, (_, i) => addDays(today, i))
    .map((k) => {
      const d = plan.days[k] || { load: 0, blocks: [] };
      const c = capacityFor(k);
      const lightened = c < state.capacity[fromKey(k).getDay()];
      const blocks = d.blocks
        .map((b) => {
          const t = taskById(b.taskId);
          return `<div class="block"><b>${TYPES[t.type]?.emoji || ""} ${esc(t.title)}</b>${fmtH(b.hours)}${b.forced ? " · ⚠️ over limit" : ""} · due ${prettyDate(t.due)}</div>`;
        })
        .join("");
      const dues = (dueOn[k] || []).map((t) => `<div class="block due"><b>📌 Due: ${esc(t.title)}</b>${TYPES[t.type]?.label}</div>`).join("");
      const pct = c ? Math.min(100, (d.load / c) * 100) : d.load ? 100 : 0;
      return `<div class="day ${k === today ? "today" : ""}">
        <div class="day-head"><b>${prettyDate(k)}</b><span class="small muted">${fmtH(d.load)} / ${fmtH(c)}</span></div>
        ${lightened ? `<div class="small muted">💙 Lightened because you're feeling ${state.moods.find((m) => m.date === k)?.value === 5 ? "overwhelmed" : "tired"}</div>` : ""}
        <div class="day-load"><div class="${d.load > c + 1e-9 ? "over" : ""}" style="width:${pct}%"></div></div>
        ${dues}${blocks || (dues ? "" : `<div class="rest">🌿 Rest day</div>`)}
      </div>`;
    })
    .join("");
}

function renderTasks(plan) {
  const showDone = $("#show-done").checked;
  const list = state.tasks.filter((t) => showDone || !t.done).sort((a, b) => a.done - b.done || a.due.localeCompare(b.due));
  $("#task-list").innerHTML = list.length
    ? list.map((t) => `<div class="task ${t.done ? "done" : ""}">
        <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} aria-label="Mark done" />
        <div>
          <div class="t-title">${esc(t.title)}<span class="pill">${TYPES[t.type]?.label}</span></div>
          <div class="t-meta">${t.subject ? esc(t.subject) + " · " : ""}Due ${prettyDate(t.due)} · ${fmtH(t.hours)} · difficulty ${t.difficulty}/5 · weight ${taskWeight(t).toFixed(1)}</div>
          ${plan.overflow[t.id] ? `<div class="t-warn">⚠️ ${fmtH(plan.overflow[t.id])} over your daily limits</div>` : ""}
        </div>
        <div class="t-actions"><button data-edit="${t.id}">Edit</button><button data-del="${t.id}">Delete</button></div>
      </div>`).join("")
    : `<div class="empty">No tasks yet.</div>`;
  $("#subjects").innerHTML = [...new Set(state.tasks.map((t) => t.subject).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join("");
}

function renderSettings() {
  if (document.activeElement?.closest("#view-settings")) return; // don't clobber typing
  $("#s-name").value = state.name;
  $("#s-key").value = state.geminiKey;
  $("#s-model").value = state.geminiModel;
  $("#capacity").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((i) => `<label>${DAY_NAMES[i]}<input type="number" min="0" max="12" step="0.5" data-cap="${i}" value="${state.capacity[i]}" /></label>`)
    .join("");
}

/* ---------------- Events ---------------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function goto(view) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) return goto(tab.dataset.view);
  const link = e.target.closest("[data-goto]");
  if (link) { e.preventDefault(); return goto(link.dataset.goto); }

  const mood = e.target.closest(".mood");
  if (mood) {
    const date = todayKey();
    state.moods = state.moods.filter((m) => m.date !== date);
    state.moods.push({ date, value: +mood.dataset.mood });
    state.moods.sort((a, b) => a.date.localeCompare(b.date));
    save();
    return toast(+mood.dataset.mood >= 4 ? "Thanks for being honest. Today's plan has been lightened 💙" : "Check-in saved!");
  }

  const del = e.target.dataset.del;
  if (del) {
    const t = taskById(del);
    if (confirm(`Delete "${t.title}"?`)) { state.tasks = state.tasks.filter((x) => x.id !== del); save(); toast("Task deleted. Plan rebalanced."); }
    return;
  }
  const edit = e.target.dataset.edit;
  if (edit) return startEdit(taskById(edit));
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset.done;
  if (id) {
    const t = taskById(id);
    t.done = e.target.checked;
    save();
    toast(t.done ? "Nice work! 🎉 Plan rebalanced." : "Task reopened.");
  }
  if (e.target.id === "show-done") render();
  if (e.target.dataset.cap !== undefined) {
    state.capacity[+e.target.dataset.cap] = Math.max(0, Math.min(12, parseFloat(e.target.value) || 0));
    save();
  }
});

$("#t-diff").addEventListener("input", (e) => ($("#t-diff-out").textContent = e.target.value));
$("#t-type").addEventListener("change", () => { if (!$("#t-id").value && !$("#t-hours").dataset.touched) quickEstimate(); });
$("#t-hours").addEventListener("input", (e) => (e.target.dataset.touched = "1"));

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

function quickEstimate() {
  const f = readForm();
  const est = estimateLocal(f.type, f.difficulty, `${f.title} ${f.desc}`);
  $("#t-hours").value = est.hours;
  $("#estimate-note").textContent = `Estimate: ${est.reason}`;
}

$("#estimate-btn").addEventListener("click", async () => {
  const f = readForm();
  const btn = $("#estimate-btn");
  if (state.geminiKey) {
    btn.disabled = true; btn.textContent = "Thinking…";
    try {
      const est = await estimateWithGemini(f);
      $("#t-hours").value = est.hours;
      if (est.difficulty >= 1 && est.difficulty <= 5) { $("#t-diff").value = Math.round(est.difficulty); $("#t-diff-out").textContent = Math.round(est.difficulty); }
      $("#estimate-note").textContent = est.reason;
    } catch (err) {
      quickEstimate();
      $("#estimate-note").textContent += ` (Gemini unavailable: ${err.message}, used offline estimator)`;
    } finally {
      btn.disabled = false; btn.textContent = "✨ Estimate for me";
    }
  } else {
    quickEstimate();
  }
});

$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = readForm();
  if (!f.hours || f.hours <= 0) { quickEstimate(); f.hours = parseFloat($("#t-hours").value); }
  const id = $("#t-id").value;
  if (id) Object.assign(taskById(id), f);
  else state.tasks.push({ id: uid(), done: false, ...f });
  resetForm();
  save();
  toast(id ? "Task updated. Plan rebalanced." : "Task added. Plan rebalanced ⚡");
});

function startEdit(t) {
  goto("tasks");
  $("#t-id").value = t.id;
  $("#t-title").value = t.title;
  $("#t-subject").value = t.subject || "";
  $("#t-type").value = t.type;
  $("#t-due").value = t.due;
  $("#t-diff").value = t.difficulty;
  $("#t-diff-out").textContent = t.difficulty;
  $("#t-desc").value = t.desc || "";
  $("#t-hours").value = t.hours;
  $("#t-hours").dataset.touched = "1";
  $("#save-task").textContent = "Save changes";
  $("#cancel-edit").classList.remove("hidden");
}
function resetForm() {
  $("#task-form").reset();
  $("#t-id").value = "";
  $("#t-diff-out").textContent = "3";
  delete $("#t-hours").dataset.touched;
  $("#t-due").value = addDays(todayKey(), 3);
  $("#save-task").textContent = "Add task";
  $("#cancel-edit").classList.add("hidden");
  $("#estimate-note").textContent = "";
  quickEstimate();
  $("#estimate-note").textContent = "";
}
$("#cancel-edit").addEventListener("click", resetForm);

$("#s-name").addEventListener("input", (e) => { state.name = e.target.value.trim(); save(); });
$("#s-key").addEventListener("input", (e) => { state.geminiKey = e.target.value.trim(); save(); });
$("#s-model").addEventListener("input", (e) => { state.geminiModel = e.target.value.trim() || "gemini-2.5-flash"; save(); });

$("#load-demo").addEventListener("click", () => {
  if (state.tasks.length && !confirm("Replace your current tasks and check-ins with demo data?")) return;
  const t = todayKey();
  const mk = (title, subject, type, dueIn, difficulty, hours, desc = "") => ({ id: uid(), done: false, title, subject, type, due: addDays(t, dueIn), difficulty, hours, desc });
  state.tasks = [
    mk("Math Test: Derivatives", "AP Calculus", "test", 3, 4, 5),
    mk("Chemistry Quiz", "Chemistry", "quiz", 4, 3, 2),
    mk("Spanish Vocab Ch. 5", "Spanish", "homework", 2, 2, 1),
    mk("English Essay: The Great Gatsby", "English", "essay", 5, 4, 5, "Write a 5 page analysis with at least 3 sources."),
    mk("APUSH Reading Ch. 9-10", "APUSH", "homework", 6, 3, 3),
    mk("Physics Lab Report", "Physics", "project", 9, 3, 4, "Lab report with graphs"),
    mk("Bio Unit Test", "Biology", "test", 11, 4, 5),
  ];
  const moods = [2, 2, 3, 2, 3, 4, 3, 4];
  state.moods = moods.map((value, i) => ({ date: addDays(t, i - moods.length + 1), value }));
  if (!state.name) state.name = "Alex";
  save();
  goto("dashboard");
  toast("Demo data loaded");
});

$("#export").addEventListener("click", () => {
  const { geminiKey, ...safe } = state; // never export the API key
  const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `overload-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#reset").addEventListener("click", () => {
  if (!confirm("Erase all tasks, check-ins and settings on this device?")) return;
  state = defaultState();
  save();
  toast("Everything erased");
});

/* ---------------- Boot ---------------- */
resetForm();
render();
// Re-render at midnight-ish so "today" stays correct if the tab is left open.
setInterval(() => { if (render.lastDay !== todayKey()) { render.lastDay = todayKey(); render(); } }, 60000);
render.lastDay = todayKey();
