"use client";

/**
 * Automated Sales — route-change tracking for client-side-routed Next.js
 * apps (App Router).
 * ----------------------------------------------------------------
 * automated-sales-tracker.js (server/public/) auto-tracks the very first
 * page of a visit when it loads, but a Next.js app doesn't do a full page
 * reload on internal navigation (next/link swaps content in place) — so
 * without this, only that first page ever gets tracked, and every
 * subsequent page a visitor clicks to is invisible to attribution.
 *
 * Drop this component in once, in your root layout (see below), and it
 * calls window.ASTracker.trackPageview() on every route change after the
 * first. It does NOT call trackPageview() on the initial mount — the
 * tracker script's own auto-fire on load already covers that page, and
 * calling it again here would double-count it.
 *
 * Usage in app/layout.tsx:
 *
 *   import AttributionRouteTracker from '@/components/AttributionRouteTracker';
 *   ...
 *   <body>
 *     ...
 *     <AttributionRouteTracker />
 *     ...
 *   </body>
 *
 * Place it anywhere in <body> — it renders nothing (returns null), it
 * just runs the effect below on every pathname change.
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

declare global {
  interface Window {
    ASTracker?: {
      trackPageview?: () => void;
      identify?: (email: string) => void;
      getAnonymousId?: () => string;
    };
  }
}

export default function AttributionRouteTracker() {
  const pathname = usePathname();
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      // The tracker script's own load-time call already tracked this
      // first page — don't double-count it.
      isFirstRender.current = false;
      return;
    }
    window.ASTracker?.trackPageview?.();
  }, [pathname]);

  return null;
}
