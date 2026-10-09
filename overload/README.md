# Overload: Academic Workload Intelligence Platform

Overload helps high school students spot burnout before it happens. Planners and calendars only track tasks. Overload looks at **how heavy** your workload is, **where deadlines pile up** and **how you're feeling**. It turns that into a **Burnout Risk score** and automatically spreads your study time so no single day gets overloaded.

**Live app:** https://parasme277.github.io/eye/overload/ (once GitHub Pages is on)

## Run it

No install or build step is needed.

- **Locally:** open `overload/index.html` in any browser.
- **Online (GitHub Pages):** in the repo, go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.

The first time you open it, a short welcome tour sets you up. Pick **Explore with example data** to see a filled-in sample week.

## Screens

| Screen | What it does |
|---|---|
| **Welcome** | Four steps: your name, how much you can study on school days and weekends (with a live week preview), how Overload works, then add your first assignment or explore example data. |
| **Today** | The first visit each day opens with a mood check-in. After that you get today's plan as a checklist: tick things off, or press ▶ to open the focus timer inside the card. You also see your next deadlines, your mood and your Burnout Risk ring with two suggestions. |
| **Focus mode** | A 25, 45 or 60 minute timer inside the task card. It keeps counting in other tabs, plays a soft chime when time's up, logs the time to that assignment and suggests a 5-minute break. |
| **Burnout risk** | Tap the ring. You see the score split into its five factors, a plain-language reason for each, where you sit on the Low / Moderate / High scale, and two things you can do about it. |
| **Add assignment** | Title, subject, due date, difficulty and type, plus the pasted description. Overload reads it for pages, chapters, problems and sources, shows its estimate line by line, and previews how the work spreads over the coming days. |
| **Plan** | A 14-day chart of your plan against last-minute cramming, then each day as a card with its study blocks sized by time. Back-to-back free days merge into one "Rest days" card. |
| **Check-ins** | Your two weeks as mood tiles, each tinted by how the day felt, with hours studied and a feather on days Overload lightened. Summary cards show your daily average, mood mix and lighter days. |
| **Settings** | Name, study-time sliders (or type a value), light and dark mode, optional Google Gemini, export, delete everything, and replay the welcome tour. |

## How it works

- **Planning:** every assignment is split into 15-minute pieces and spread across the days before it's due. Each piece goes to the least-loaded day, measured against your own daily limit. The plan rebuilds whenever you add an assignment, tick something off, log time or check in.
- **Lighter days:** checking in as *Tired* or *Stressed* lowers today's limit by 25% or 50% and moves the extra work to later days. An **Undo** button puts it back.
- **Burnout Risk (0–100):** five factors worth up to 20 points each.

| Factor | Measures |
|---|---|
| Work planned this week | Planned hours compared with the time you have over the next 7 days |
| Your busiest day | Your heaviest day compared with that day's limit |
| Deadlines bunched together | How many weighty deadlines land within 5 days of each other |
| More work than time | Hours that can't fit under your limits before they're due |
| How you've been feeling | Your last five check-ins, with stressed and tired days counting most |

Low is 0–33, Moderate is 34–66 and High is 67–100.

## AI (Google Gemini, optional)

Overload's built-in estimator works offline. For a second opinion, turn on **Use Google Gemini** in Settings and paste a free key from [Google AI Studio](https://aistudio.google.com/apikey). The key is stored only in your browser, and only the assignment's title and description are sent.

To give every student AI estimates without anyone needing a key, deploy the small proxy in [`worker/`](worker/README.md) and paste its URL into `AI_ENDPOINT` at the top of `app.js`.

## Privacy

There are no accounts. Assignments, the plan and check-ins live only in this browser (`localStorage`).

## Design

Built on the "Organic" design system: Caprasimo headings, Figtree body text, a cream background with terracotta and sage accents, and very round cards and pill buttons. Each subject gets its own color. Green, amber and red appear only where something needs attention. Icons are from [Lucide](https://lucide.dev).

## Files

- `index.html`: page shell, sidebar and icons
- `style.css`: design tokens (light and dark) and components
- `app.js`: estimates, scheduler, burnout score, focus timer and every screen
- `worker/worker.js`: optional AI proxy that keeps a shared Gemini key off the page
