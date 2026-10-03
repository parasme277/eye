# Turning on AI estimates (your Gemini key, shared safely)

**Why a proxy?** Overload runs entirely in the browser, so anything inside `app.js` can be read by anyone who visits the site. If you put your Gemini key there, anyone could copy it and use up your quota. Instead, this small free **Cloudflare Worker** holds the key as a secret. The app sends the assignment to the worker, the worker asks Gemini, and only the estimate comes back. Users never see the key, and they don't need their own.

The worker does only one thing (estimate assignment time), only accepts requests from your site, and limits how many requests each visitor can make per minute, so it can't be abused as a free chatbot.

## Setup (about 10 minutes, free)

1. **Get a Gemini key:** go to https://aistudio.google.com/apikey and click **Create API key**. Copy it.
2. **Create a Cloudflare account:** sign up for free at https://dash.cloudflare.com/sign-up.
3. **Create the worker:**
   - In the dashboard, go to **Workers & Pages → Create → Create Worker** (pick the "Hello World" starter).
   - Name it, for example `overload-ai`, and click **Deploy**.
   - Click **Edit code**, delete everything, paste in all of [`worker.js`](worker.js), and click **Deploy**.
4. **Add your key as a secret:**
   - Go to the worker's **Settings → Variables and Secrets → Add**.
   - Type: **Secret**, Name: `GEMINI_API_KEY`, Value: your key. Save.
   - Add another one. Type: **Text**, Name: `ALLOWED_ORIGINS`, Value: `https://parasme277.github.io`. Save.
5. **Copy the worker URL.** It looks like `https://overload-ai.<your-name>.workers.dev`.
6. **Connect the app:** at the top of `overload/app.js`, paste the URL in:
   ```js
   const AI_ENDPOINT = "https://overload-ai.<your-name>.workers.dev";
   ```
   Commit and push. In Overload, **Settings → AI estimates** should now say *Connected*.

## Test it

```bash
curl -X POST https://overload-ai.<your-name>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Origin: https://parasme277.github.io" \
  -d '{"title":"Gatsby essay","type":"essay","difficulty":3,"desc":"5 page analysis with 3 sources"}'
```

You should get something like `{"hours":6,"difficulty":3,"reason":"..."}`. If you get an error, the message says what went wrong (for example an invalid key, or a model name your key can't use).

## Good to know

- **Cost:** Gemini's free tier and Cloudflare Workers' free plan (100,000 requests per day) are plenty for a school project. Check current limits in Google AI Studio.
- **Never commit your key** to GitHub. It only belongs in the worker's secret settings.
- **Model:** the default is `gemini-2.5-flash`. To use a different one, add a Text variable named `GEMINI_MODEL`.
- **If AI is down,** Overload automatically falls back to its built-in estimator, so the app keeps working.
