# Installing the tracker via Google Tag Manager

Two ways to get the tracker onto a client's site through GTM instead of
editing their site's code directly. Both end up doing the exact same
thing as the raw `<script>` tag in the root README: setting
`window.AS_TRACKER_API_URL` / `window.AS_TRACKER_KEY`, then loading
`automated-sales-tracker.js`.

## Option A — Custom HTML tag (recommended, zero risk)

File: `custom-html-tag.html`

This is GTM's built-in "Custom HTML" tag type — you paste raw HTML/JS
into a field GTM already knows how to run. There's no import step and
nothing that can fail to parse; if the client already has GTM on their
site, this works every time.

1. GTM > Tags > New > Tag Configuration > **Custom HTML**
2. Paste in the contents of `custom-html-tag.html`
3. Fill in the two placeholders with the values `npm run add-tenant`
   printed for this client (section "1. WEBSITE" of that output) and
   the script host (section "1. WEBSITE" also has the full
   `<script src="...">` line to copy the host from)
4. Trigger: **All Pages**
5. Save, Submit, Publish

This is the path to hand to a client (or their agency) by default.

## Option B — Custom Template (`.tpl`)

File: `automated-sales-tracker.tpl`

A proper GTM template gives the tag a real form (two labeled text
fields instead of a paste-and-edit HTML block) and shows up in the
tag-type picker like a native GTM tag. Nicer for a client's marketing
team to self-serve once it's set up, but it's an extra import step and
GTM's sandboxed JS environment is stricter than plain HTML.

**Status: unverified.** The file is built correctly against Google's
published Sandboxed JS API reference and the internal permissions JSON
format (confirmed against real working community templates — see the
`___NOTES___` section inside the file for exactly what was checked and
against what), but it has not been imported into a live GTM container
by us. Read the `___NOTES___` section in the file before using it —
it has the exact setup steps and what to check in Preview mode. If
anything about it doesn't import or fire cleanly, Option A is the
fallback and is guaranteed to work.

To use it: edit the two `YOUR-DEPLOYED-API-HOST` placeholders inside
the file first (one in the JS, one in the permissions block — they
must match exactly), then GTM > Templates > New > import.

## Either way

Forms with a recognizable email field are picked up automatically —
no extra GTM configuration needed for most WordPress/Webflow/plain-HTML
forms. Tools that don't fire a native form submit event (Calendly,
Typeform, custom JS widgets) need one manual call on success:

```js
window.ASTracker.identify(email)
```

See the root README's "Installing the snippet" section for where that
line typically goes for common tools, and for the WordPress-plugin
alternative if the client doesn't use GTM at all.
