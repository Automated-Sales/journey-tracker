/**
 * Automated Sales — Prospect Journey Tracker
 * ----------------------------------------------------------------
 * Drop this on every page of your marketing site (e.g. via Google Tag
 * Manager, or a <script> tag right before </body>). It captures:
 *   - every pageview, with UTM params, ad click IDs (gclid, li_fat_id,
 *     msclkid, fbclid), and the referring URL
 *   - a persistent anonymous ID per visitor, so their pre-conversion
 *     path (ad click -> blog -> pricing page) can be stitched together
 *     once they identify themselves
 *
 * Usage — both values below are printed for you by `npm run add-tenant`
 * when this business is onboarded; AS_TRACKER_API_URL already includes
 * this business's tenant path (.../t/<slug>), and AS_TRACKER_KEY scopes
 * every call to that one business so it can never read or write another
 * client's data:
 *   <script>
 *     window.AS_TRACKER_API_URL = "https://journey-api.yourdomain.com/t/acme-co";
 *     window.AS_TRACKER_KEY = "the trackKey printed by add-tenant";
 *   </script>
 *   <script src="/automated-sales-tracker.js"></script>
 *
 * FORMS: you usually don't need to wire anything up by hand. This script
 * also listens for every form submit on the page and, if it finds a
 * field that looks like an email address (type="email", or a name/id/
 * placeholder containing "email"), calls identify() with it
 * automatically. That covers most WordPress form plugins (Contact Form
 * 7, WPForms, Gravity Forms, native `<form>`s), Webflow forms, and plain
 * HTML forms with zero per-client code.
 *
 * It won't catch forms that don't fire a native `submit` event — some
 * JS-only widgets (Calendly, Typeform, a custom React form that calls
 * fetch() directly) skip that entirely. For those, call this manually
 * from wherever you already handle a successful submission:
 *   window.ASTracker.identify("prospect@company.com");
 * Either way, that's the call that links everything captured
 * anonymously up to that point onto a real identity, so it shows up in
 * the Pipedrive panel once a Person record with the same email exists.
 *
 * TIME ON PAGE: each pageview also reports how long the visitor stayed,
 * for future lead-scoring use. This fires automatically on tab hide,
 * page unload, or (on single-page apps) right before the next page is
 * tracked — see trackPageview() below. Client-side-routed apps (Next.js,
 * React Router, etc.) don't reload the page on internal navigation, so
 * this script's own auto-fire on load only catches the first page of a
 * visit; call window.ASTracker.trackPageview() on route change to track
 * the rest (see the AttributionRouteTracker component pattern in the
 * project's docs for a Next.js App Router example).
 */
(function () {
  var API_URL = window.AS_TRACKER_API_URL || "http://localhost:8787/t/local-dev";
  var TRACK_KEY = window.AS_TRACKER_KEY || "";
  var COOKIE_NAME = "as_anon_id";
  var COOKIE_DAYS = 365;

  function readCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/; SameSite=Lax";
  }

  function randomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "anon_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  }

  function getAnonymousId() {
    var id = readCookie(COOKIE_NAME);
    if (!id) {
      id = randomId();
      writeCookie(COOKIE_NAME, id, COOKIE_DAYS);
    }
    return id;
  }

  function parseParams() {
    var params = new URLSearchParams(window.location.search);
    var utm = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (key) {
      var val = params.get(key);
      if (val) utm[key] = val;
    });
    var clickIds = {};
    ["gclid", "li_fat_id", "msclkid", "fbclid"].forEach(function (key) {
      var val = params.get(key);
      if (val) clickIds[key] = val;
    });
    return { utm: utm, clickIds: clickIds };
  }

  function apiUrl(path) {
    // The track key goes on the query string, not a header — sendBeacon
    // can't set custom headers, and this is a public-ish key baked into
    // client-side JS anyway, not a real secret; it just scopes writes to
    // this one tenant so one client's snippet can't touch another's data.
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return API_URL + path + (TRACK_KEY ? sep + "key=" + encodeURIComponent(TRACK_KEY) : "");
  }

  // Fire-and-forget, for calls that don't need a response back (identify,
  // the duration beacon). sendBeacon is preferred since it's designed to
  // reliably complete even as the page is being torn down; fetch+keepalive
  // is the fallback for browsers without it.
  function postBeacon(path, body) {
    var url = apiUrl(path);
    var payload = JSON.stringify(body);
    if (navigator.sendBeacon) {
      var blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(function () {
      /* swallow — tracking must never break the page */
    });
  }

  // State for the currently-open page's dwell-time measurement. Only one
  // page is ever "open" at a time from this script's point of view, even
  // on an SPA — flushDuration() closes out the previous one before
  // trackPageview() opens the next.
  var currentTouchpointId = null;
  var pageEnteredAt = null;

  function flushDuration() {
    if (!currentTouchpointId || pageEnteredAt === null) return;
    var touchpointId = currentTouchpointId;
    var durationMs = Date.now() - pageEnteredAt;
    currentTouchpointId = null;
    pageEnteredAt = null;
    if (durationMs < 250) return; // not a real page view (redirect, bounce)
    postBeacon("/api/track/duration", { touchpointId: touchpointId, durationMs: durationMs });
  }

  function trackPageview() {
    // Closes out whatever page was previously "open" and records its
    // dwell time, before this one starts its own clock. On a normal
    // multi-page site this is a no-op on the very first call (nothing to
    // flush yet); on an SPA calling trackPageview() again on route
    // change, this is what actually captures the previous page's time —
    // visibilitychange/pagehide below only fire when leaving the site
    // entirely, not on an in-app client-side navigation.
    flushDuration();

    var anonymousId = getAnonymousId();
    var parsed = parseParams();
    var enteredAt = Date.now();

    // Needs the JSON response (for touchpointId) rather than sendBeacon,
    // which is fire-and-forget with no way to read anything back. Still
    // non-blocking — fetch() doesn't hold up page rendering or navigation
    // either way, and keepalive:true keeps it reliable even if navigation
    // happens moments later.
    fetch(apiUrl("/api/track"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymousId: anonymousId,
        url: window.location.href,
        title: document.title,
        // Only meaningful on the very first pageview of a visit (a
        // same-tab client-side route change doesn't change what the
        // browser reports here) — that's exactly when it matters most,
        // since it's the first-touch signal for "where did they come
        // from" (google.com, facebook.com, another site linking in, or
        // "" for direct/typed-URL traffic).
        referrer: document.referrer || "",
        utm: parsed.utm,
        clickIds: parsed.clickIds,
      }),
      keepalive: true,
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data && data.touchpointId) {
          currentTouchpointId = data.touchpointId;
          pageEnteredAt = enteredAt;
        }
      })
      .catch(function () {
        /* swallow — a lost response just means this page's duration won't be tracked */
      });

    // Ad click IDs are only present on the URL for the landing pageview,
    // but the visitor's intent to convert may not happen for weeks. Persist
    // them alongside the anonymous ID so later pageviews on this session
    // don't lose the original attribution details.
    if (Object.keys(parsed.clickIds).length || Object.keys(parsed.utm).length) {
      try {
        sessionStorage.setItem("as_first_touch", JSON.stringify(parsed));
      } catch (e) {
        /* ignore storage errors (private browsing, etc.) */
      }
    }
  }

  // Backstop for actually leaving the site (closing the tab, navigating
  // to another domain, backgrounding on mobile) — trackPageview()'s own
  // flushDuration() call handles in-app SPA navigation, but nothing
  // subsequently calls trackPageview() when the visitor just leaves.
  // visibilitychange fires more reliably than pagehide/beforeunload
  // across mobile browsers, so it's the primary signal; pagehide is a
  // second attempt in case visibilitychange was missed.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushDuration();
  });
  window.addEventListener("pagehide", flushDuration);

  var lastIdentifiedEmail = null;

  function identify(email) {
    if (!email) return;
    email = String(email).trim().toLowerCase();
    if (!email || email === lastIdentifiedEmail) return; // avoid duplicate calls for the same visitor
    lastIdentifiedEmail = email;
    postBeacon("/api/identify", { email: email, anonymousId: getAnonymousId(), url: window.location.href });
  }

  var EMAIL_HINT = /email/i;
  var EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function looksLikeEmailField(el) {
    if (!el || !("value" in el)) return false;
    if (el.type === "email") return true;
    var hints = [el.name, el.id, el.getAttribute && el.getAttribute("placeholder"), el.getAttribute && el.getAttribute("aria-label")];
    return hints.some(function (h) {
      return h && EMAIL_HINT.test(h);
    });
  }

  function findEmailInForm(form) {
    var fields = form.elements ? Array.prototype.slice.call(form.elements) : [];
    // Prefer a field that's explicitly hinted as an email field...
    var hinted = fields.filter(looksLikeEmailField).map(function (f) { return f.value; }).find(function (v) { return EMAIL_LIKE.test(v || ""); });
    if (hinted) return hinted;
    // ...but fall back to any field whose value just looks like an email,
    // in case the field itself isn't labeled clearly.
    var fallback = fields.map(function (f) { return f.value; }).find(function (v) { return EMAIL_LIKE.test(v || ""); });
    return fallback || null;
  }

  function onFormSubmit(event) {
    var form = event.target;
    if (!form || form.tagName !== "FORM") return;
    try {
      var email = findEmailInForm(form);
      if (email) identify(email);
    } catch (e) {
      /* auto-detection must never break the client's form */
    }
  }

  // Capture phase so this still runs even if the form's own handler
  // calls stopPropagation() (common in JS-driven form plugins) — it
  // won't run if the plugin stops the event in the *capture* phase
  // itself before reaching us, which is rare.
  document.addEventListener("submit", onFormSubmit, true);

  trackPageview();

  window.ASTracker = {
    identify: identify,
    getAnonymousId: getAnonymousId,
    // Call this after a client-side route change on a single-page app
    // (Next.js, React Router, etc.) — see the file header comment above.
    // Not needed on a traditional multi-page site; every real page load
    // already re-runs this whole script from the top.
    trackPageview: trackPageview,
  };
})();
