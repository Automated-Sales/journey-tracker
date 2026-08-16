import { useEffect, useRef, useState } from "react";
import AppExtensionsSDK, { Command } from "@pipedrive/app-extensions-sdk";
import Timeline from "./Timeline";
import { fetchJourneyByPerson, fetchJourneyByDeal, JourneyResponse } from "./api";

/**
 * Pipedrive Custom UI Extension — rendered inside an iframe on the Deal
 * and Person detail views (see pipedrive-app/app-manifest.json for the
 * placement config).
 *
 * Pipedrive appends context to the iframe URL as query params, notably:
 *   - id            runtime token the SDK needs to initialize
 *   - resource      "deal" | "person" | ...
 *   - selectedIds   the ID of the record currently being viewed
 * The SDK reads `id` off the URL automatically, so initialize() needs no
 * arguments. See: https://pipedrive.readme.io/docs/custom-ui-extensions
 */
export default function App() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: JourneyResponse }
  >({ status: "loading" });

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const params = new URLSearchParams(window.location.search);
        const resource = params.get("resource"); // "deal" | "person"
        const selectedId = params.get("selectedIds");

        // The SDK call is wrapped in try/catch and treated as best-effort:
        // it's needed to resize the iframe nicely inside Pipedrive, but the
        // panel should still work (e.g. during local `vite dev` outside an
        // iframe) even if it fails.
        let sdk: AppExtensionsSDK | null = null;
        try {
          sdk = await new AppExtensionsSDK().initialize();
        } catch {
          // Not running inside Pipedrive (e.g. local dev) — ignore.
        }

        if (!selectedId || (resource !== "person" && resource !== "deal")) {
          if (!cancelled) {
            setState({ status: "error", message: "This panel only renders on Deal and Person records." });
          }
          return;
        }

        // On a Deal view, Pipedrive only gives us the Deal ID — the API
        // resolves that to the linked Person server-side (see
        // /api/journey/by-deal in server/src/routes/journey.ts).
        const data =
          resource === "person"
            ? await fetchJourneyByPerson(Number(selectedId))
            : await fetchJourneyByDeal(Number(selectedId));

        if (cancelled) return;
        setState({ status: "ready", data });

        if (sdk && containerRef.current) {
          const height = Math.max(160, Math.min(750, containerRef.current.scrollHeight + 24));
          await sdk.execute(Command.RESIZE, { height });
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: "error", message: err.message || "Failed to load journey." });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="panel" ref={containerRef}>
      <div className="panel-header">
        <span className="panel-title">Prospect journey</span>
      </div>

      {state.status === "loading" && <div className="state-message">Loading journey…</div>}
      {state.status === "error" && <div className="error-state">{state.message}</div>}
      {state.status === "ready" && (
        <>
          {state.data.identity?.email && (
            <div className="panel-subtitle">
              {state.data.touchpoints.length} touchpoint{state.data.touchpoints.length === 1 ? "" : "s"} for{" "}
              {state.data.identity.email}
            </div>
          )}
          <Timeline touchpoints={state.data.touchpoints} />
        </>
      )}
    </div>
  );
}
