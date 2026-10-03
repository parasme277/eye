# ⚡ Overload: Academic Workload Intelligence Platform

Overload helps high school students spot burnout before it happens. Planners and calendars only track tasks. Overload looks at **how heavy** your workload is, **where deadlines pile up** and **how you're feeling**. It turns that into a **Burnout Risk Index** and automatically rebalances your study plan so no single day gets overloaded.

## Run it

No install or build step is needed.

- **Locally:** open `overload/index.html` in any browser.
- **Online (GitHub Pages):** go to repo **Settings → Pages**, set **Source** to *Deploy from a branch*, pick your branch and `/ (root)`, and save. The app will then be at `https://<username>.github.io/<repo>/overload/`.

To try it fast, open **Settings → Load demo data**.

## Features

| Feature | What it does |
|---|---|
| **Weighted task scoring** | Each task gets a weight from its type (test > project > essay > quiz > homework), difficulty (1–5) and size. |
| **Smart effort estimation** | Paste an assignment description. Overload reads it for page counts, chapters, problems, sources and keywords like "lab report" or "cumulative" to estimate the hours. Gemini is optional (see below). |
| **Automatic schedule redistribution** | A load-balancing scheduler splits every task into 30-minute blocks across the days before it's due. Each block goes to the least-loaded day, measured against your own daily limit. Everything rebalances whenever you add, finish or edit a task. |
| **Workload intensity forecast** | A 14-day chart compares Overload's plan with last-minute cramming, so you can see how much lighter your busiest day gets. |
| **Deadline clustering detection** | Flags any 3-day window where several heavy deadlines pile up. |
| **Stress trend tracking** | A one-tap daily mood check-in, charted over time. |
| **Wellness-aware scheduling** | Checking in as *Tired* or *Overwhelmed* automatically lowers today's study limit (by 25% or 50%) and moves the extra work to later days. |
| **Burnout Risk Index (0–100)** | Combines five factors (below) and shows exactly where each point comes from. |
| **Insights** | Plain-language warnings and suggestions: overdue work, over-capacity tasks, clusters, rest days. |

### Burnout Risk Index formula

| Factor | Max points | Measures |
|---|---|---|
| Sustained load | 30 | Planned hours ÷ your capacity over the next 7 days |
| Peak day | 20 | Your heaviest day compared with that day's limit |
| Deadline clustering | 20 | Total task weight due inside any 3-day window |
| Over capacity | 15 | Hours that can't fit under your limits at all |
| Stress trend | 15 | Average of recent mood check-ins, plus whether they're getting worse |

0–34 = Low risk · 35–64 = Moderate · 65+ = High

### Optional: Google Gemini

In **Settings**, add a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). The *Estimate for me* button will then send the assignment description to Gemini, which estimates the hours and difficulty. The key is stored only in your browser and is never included in exports. If Gemini is unavailable, Overload falls back to the offline estimator.

## Privacy

All data stays in your browser (`localStorage`). There are no accounts and no servers.

## Tech

HTML, CSS and vanilla JavaScript. There are no frameworks or dependencies, so it works on any device with a browser.

- `index.html`: layout
- `style.css`: design
- `app.js`: scoring, estimation, scheduler, risk index and UI
