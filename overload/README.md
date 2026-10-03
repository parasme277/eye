# ⚡ Overload: Academic Workload Intelligence Platform

Overload helps high school students spot burnout before it happens. Planners and calendars only track tasks. Overload looks at **how heavy** your workload is, **where deadlines pile up** and **how you're feeling**. It turns that into a **Burnout Risk Index** and automatically rebalances your study plan so no single day gets overloaded.

**Live app:** https://parasme277.github.io/eye/overload/ (once GitHub Pages is on)

## Run it

No install or build step is needed.

- **Locally:** open `overload/index.html` in any browser.
- **Online (GitHub Pages):** in the repo, go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.

To try it fast, open **Settings → Load demo data**.

## Features

| Feature | What it does |
|---|---|
| **Burnout Risk Index (0–100)** | Combines five factors (below) and shows exactly where each point comes from. |
| **Automatic schedule redistribution** | A load-balancing scheduler splits every task into 30-minute blocks across the days before it's due. Each block goes to the least-loaded day, measured against your own daily limit. Everything rebalances whenever you add, finish, edit or log work. |
| **Focus timer** | 25/45/60-minute focus sessions with breaks. It keeps running if you switch tabs, plays a chime and sends a notification when time's up, and saves the time to the task you're working on. |
| **Work log & streaks** | Tap **I worked today** or **Log time** for work done away from the app. Logged time counts against each task's remaining hours and today's limit. Consecutive days build a streak. |
| **Daily check-in** | A one-tap mood check-in. The **last 14 days** view shows mood and hours worked per day, and fills in from your very first day. |
| **Wellness-aware scheduling** | Checking in as *Tired* or *Stressed* lowers today's study limit (by 25% or 50%) and moves the extra work to later days. |
| **Smart effort estimation** | Paste an assignment description and get an hours estimate. It updates live as you type, and **Estimate with AI** uses Google Gemini. |
| **Workload forecast** | A 14-day chart compares Overload's plan with last-minute cramming, so you can see how much lighter your busiest day gets. |
| **Deadline pile-up detection** | Flags any 3-day window where several heavy deadlines pile up. |
| **Insights** | Plain-language warnings and suggestions: overdue work, over-limit tasks, pile-ups, rest days. |
| **Light & dark mode** | Follows your device setting by default, or pick one in the sidebar or Settings. |
| **Mobile-friendly** | Bottom tab bar and layouts built for phone screens. |

### Burnout Risk Index formula

| Factor | Max points | Measures |
|---|---|---|
| Weekly load | 30 | Planned hours ÷ your limits over the next 7 days |
| Busiest day | 20 | Your heaviest day compared with that day's limit |
| Deadline pile-up | 20 | Total task weight due inside any 3-day window |
| Over your limits | 15 | Hours that can't fit under your limits at all |
| Stress level | 15 | Average of recent check-ins, plus whether they're getting worse |

0–34 = Low risk · 35–64 = Moderate · 65+ = High

## AI (Google Gemini)

Students don't need their own API key. Your key is stored in a tiny free proxy (a Cloudflare Worker), so it is never exposed in the website's code. Setup steps are in [`worker/README.md`](worker/README.md). Until it's connected, Overload uses its built-in offline estimator.

## Privacy

All data stays in your browser (`localStorage`). There are no accounts. The only thing ever sent anywhere is an assignment's title and description, and only when you click **Estimate with AI**.

## Tech

HTML, CSS and vanilla JavaScript. There are no frameworks or dependencies.

- `index.html`: layout
- `style.css`: design, with light/dark theme tokens
- `app.js`: scoring, scheduler, risk index, timer, logging and UI
- `worker/worker.js`: the AI proxy that keeps the Gemini key secret
