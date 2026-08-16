import { Touchpoint } from "./api";

// One consistent color + label per channel, used for the small dot and
// badge in the timeline. Kept to a small, distinguishable set rather than
// one color per traffic source so the timeline stays scannable.
const CHANNEL_META: Record<string, { label: string; color: string }> = {
  ad_click: { label: "Ad click", color: "#7C5CFC" },
  ad_impression: { label: "Ad seen", color: "#A996FD" },
  website_visit: { label: "Website", color: "#2F80ED" },
  email_open: { label: "Email opened", color: "#22A699" },
  email_click: { label: "Email click", color: "#0E8074" },
  email_reply: { label: "Email reply", color: "#0B6B61" },
  pipedrive_activity: { label: "Sales activity", color: "#EF8C1F" },
  pipedrive_stage_change: { label: "Deal stage", color: "#2E7D32" },
  pipedrive_note: { label: "Note", color: "#8A8A8A" },
};

function metaFor(channel: string) {
  return CHANNEL_META[channel] || { label: channel, color: "#8A8A8A" };
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function describe(tp: Touchpoint): string {
  if (tp.title) return tp.title;
  if (tp.url) return tp.url;
  if (tp.campaign) return `${tp.source} · ${tp.campaign}`;
  return tp.source;
}

export default function Timeline({ touchpoints }: { touchpoints: Touchpoint[] }) {
  if (touchpoints.length === 0) {
    return (
      <div className="empty-state">
        No journey data captured yet for this person. Once the tracking snippet, email, or ad
        webhooks fire for their email address, their full path will appear here.
      </div>
    );
  }

  return (
    <ol className="timeline">
      {touchpoints.map((tp, i) => {
        const meta = metaFor(tp.channel);
        const isFirst = i === 0;
        const isLast = i === touchpoints.length - 1;
        return (
          <li key={tp.id} className="timeline-row">
            <div className="timeline-rail">
              <span className="timeline-dot" style={{ background: meta.color }} />
              {!isLast && <span className="timeline-line" />}
            </div>
            <div className="timeline-body">
              <div className="timeline-meta">
                <span className="timeline-badge" style={{ color: meta.color, borderColor: meta.color }}>
                  {meta.label}
                </span>
                <span className="timeline-date">{formatDate(tp.occurredAt)}</span>
                {isFirst && <span className="timeline-flag">First touch</span>}
                {isLast && <span className="timeline-flag timeline-flag-last">Most recent</span>}
              </div>
              <div className="timeline-desc">{describe(tp)}</div>
              <div className="timeline-source">{tp.source}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
