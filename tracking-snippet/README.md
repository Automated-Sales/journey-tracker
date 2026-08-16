# Tracking snippet — now centrally hosted

The snippet itself lives at `server/public/automated-sales-tracker.js` and
is served directly by the backend at:

```
<your-deployed-api-url>/automated-sales-tracker.js
```

One copy, served for every client — nobody needs to upload this file to
their own site. What's per-client is just the two config values
(`AS_TRACKER_API_URL`, `AS_TRACKER_KEY`) that `npm run add-tenant` prints,
which point at that one shared file.

See the root `README.md` → "Installing the snippet on a client's site"
for the four ways to actually get it onto a page: manual `<script>` tag,
Google Tag Manager (two options), or the WordPress plugin
(`wordpress-plugin/`).
