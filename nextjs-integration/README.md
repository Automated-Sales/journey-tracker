# Next.js App Router integration

For client-side-routed sites (Next.js, React Router, etc.) where internal
navigation doesn't trigger a full page reload. If your site is a
traditional multi-page site (WordPress, static HTML, server-rendered
pages with real `<a href>` navigation), you don't need this folder at
all — every page load already re-runs the tracking snippet from scratch.

## Why this exists

`server/public/automated-sales-tracker.js` tracks a pageview once, when
it first loads. On a normal site, every page the visitor clicks to is a
fresh page load, so the script re-runs on each one automatically. On a
Next.js App Router site using `next/link`, internal navigation swaps
content in place without reloading the page — so without this component,
only the very first page of a visit ever gets tracked.

## Setup

1. Copy `AttributionRouteTracker.tsx` into your components folder (e.g.
   `components/AttributionRouteTracker.tsx`).
2. Import it in your root layout (`app/layout.tsx`) and render it once,
   anywhere inside `<body>`:

   ```tsx
   import AttributionRouteTracker from "@/components/AttributionRouteTracker";
   // ...
   <body>
     {/* ...existing content... */}
     <AttributionRouteTracker />
   </body>
   ```

3. That's it — no props, no config. It reads `window.ASTracker`, which
   the tracking snippet already sets up.

## What it does and doesn't cover

- Covers: any navigation that changes the URL path (`usePathname()`
  changing) — clicking between pages via `next/link`, `router.push()`,
  etc.
- Doesn't cover: a query-string-only change on the same path (e.g.
  `?tab=pricing` without a path change). Rare enough for attribution
  purposes to not be worth the added complexity of also watching
  `useSearchParams()`, which would require wrapping usage in a Suspense
  boundary and could affect static rendering elsewhere in the app.
