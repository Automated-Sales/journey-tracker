// Shared per-prospect timeline rendering — used by both dashboard.html
// (the "Recently active prospects" list's expandable rows) and
// journey.html (the standalone, no-login "View full journey" page a
// Pipedrive custom field links to — see routes/portal.ts's
// /api/journey/:identityId and lib/journey-link.ts). Pulled
// out into its own file specifically so both pages render a prospect's
// history identically without copy-pasting ~250 lines of rendering logic
// between them — a change here (a new channel, a tweaked label) applies
// to both automatically. Plain global functions (not a module) since
// both pages load this as a normal, non-module <script> tag before their
// own inline script runs.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Same channel -> label/color mapping as the Pipedrive panel's Timeline
// component (panel/src/Timeline.tsx), kept in sync deliberately so a
// channel looks the same whether you're viewing it in Pipedrive or here.
var CHANNEL_META = {
  ad_click: { label: 'Ad click', color: '#7C5CFC' },
  ad_impression: { label: 'Ad seen', color: '#A996FD' },
  website_visit: { label: 'Website', color: '#2F80ED' },
  social_organic: { label: 'Organic social', color: '#D6409F' },
  email_open: { label: 'Email opened', color: '#22A699' },
  email_click: { label: 'Email click', color: '#0E8074' },
  email_reply: { label: 'Email reply', color: '#0B6B61' },
  pipedrive_activity: { label: 'Sales activity', color: '#EF8C1F' },
  pipedrive_stage_change: { label: 'Deal stage', color: '#2E7D32' },
  pipedrive_note: { label: 'Note', color: '#8A8A8A' },
};

function metaFor(channel) {
  return CHANNEL_META[channel] || { label: channel, color: '#8A8A8A' };
}

// Reverse index of CHANNEL_META, keyed by the human-readable label rather
// than the raw channel enum — needed because lib/portal-summary.ts's
// RecentProspect (unlike the per-touchpoint timeline API) already carries
// pre-labeled strings like "Ad click" rather than "ad_click". Built once
// at load time rather than per-row.
var CHANNEL_META_BY_LABEL = Object.keys(CHANNEL_META).reduce(function (acc, key) {
  acc[CHANNEL_META[key].label] = CHANNEL_META[key];
  return acc;
}, {});

function metaForLabel(label) {
  return CHANNEL_META_BY_LABEL[label] || { label: label, color: '#8A8A8A' };
}

// Same pill used in the expanded timeline (.as-timeline-badge) — reused
// for the Recently active prospects list's First touch/Last touch
// columns too, so a channel looks the same whether you're viewing the
// compact list or an expanded/standalone view.
function channelBadge(label) {
  var meta = metaForLabel(label);
  return '<span class="as-timeline-badge" style="color:' + meta.color + '">' + esc(meta.label) + '</span>';
}

function describeTouchpoint(tp) {
  if (tp.title) return tp.title;
  if (tp.url) return tp.url;
  if (tp.campaign) return tp.source + ' · ' + tp.campaign;
  return tp.source;
}

// Same label logic as describeTouchpoint, but wraps it in a link to the
// actual page when we have a URL for it — so "which page was this" never
// requires guessing from a title alone.
function describeTouchpointHtml(tp) {
  var label = describeTouchpoint(tp);
  if (tp.url) {
    return '<a href="' + esc(tp.url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>';
  }
  return esc(label);
}

// Compact form of a referrer URL: just the domain, since the full URL
// (often with tracking query params) is too long for a table cell — the
// full value is still available via the title tooltip and by clicking
// through.
function referrerDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return url;
  }
}

// Same UTM group as the Recently active prospects list's own
// Source/Medium/Campaign/Term/Content columns, but for one specific
// touchpoint in the timeline — labeled here (rather than bare column
// values) since "Term" / "Content" on their own would be ambiguous out
// of context.
function utmDetail(tp) {
  var parts = [];
  if (tp.medium) parts.push('Medium: ' + tp.medium);
  if (tp.campaign) parts.push('Campaign: ' + tp.campaign);
  if (tp.term) parts.push('Term: ' + tp.term);
  if (tp.content) parts.push('Content: ' + tp.content);
  return parts.join(' · ');
}

function clickIdSummary(tp) {
  var parts = [];
  if (tp.gclid) parts.push('GCLID: ' + tp.gclid);
  if (tp.fbclid) parts.push('FBCLID: ' + tp.fbclid);
  if (tp.msclkid) parts.push('MSCLKID: ' + tp.msclkid);
  return parts.join(' · ');
}

function formatDuration(ms) {
  if (ms == null) return null;
  var totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return totalSeconds + 's';
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  if (minutes < 60) return minutes + 'm ' + seconds + 's';
  var hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

function formatDate(occurredAt) {
  return new Date(occurredAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sumDurations(tps) {
  var total = 0, any = false;
  tps.forEach(function (tp) {
    if (tp.durationMs != null) { total += tp.durationMs; any = true; }
  });
  return any ? total : null;
}

// Collapses consecutive runs of 2+ website_visit touchpoints into a
// single group — a burst of "clicked around the site for a bit" reads as
// one line at a glance, with every individual page still one click away.
// A single isolated page visit isn't wrapped in a group of one; any other
// channel (ad click, form identified, deal stage, etc.) ends a run and
// stands on its own, since those are discrete events worth seeing
// directly rather than folded away.
function groupTouchpoints(touchpoints) {
  var groups = [];
  var i = 0;
  while (i < touchpoints.length) {
    if (touchpoints[i].channel === 'website_visit') {
      var startIndex = i;
      var run = [];
      while (i < touchpoints.length && touchpoints[i].channel === 'website_visit') {
        run.push(touchpoints[i]);
        i++;
      }
      if (run.length >= 2) {
        groups.push({ type: 'group', items: run, startIndex: startIndex, endIndex: i - 1 });
      } else {
        groups.push({ type: 'single', tp: run[0], index: startIndex });
      }
    } else {
      groups.push({ type: 'single', tp: touchpoints[i], index: i });
      i++;
    }
  }
  return groups;
}

// Shared by both a normal top-level row and a nested page inside an
// expanded group — `compact` drops the channel badge and duration
// becomes inline, since a group's own header already says "Website".
function timelineBodyHtml(tp, index, total, compact) {
  var isFirst = index === 0;
  var isLast = index === total - 1;
  var duration = formatDuration(tp.durationMs);
  var clickIds = clickIdSummary(tp);
  var utm = utmDetail(tp);
  var meta = metaFor(tp.channel);
  return (
    '<div class="as-timeline-meta">' +
      (compact ? '' : '<span class="as-timeline-badge" style="color:' + meta.color + '">' + esc(meta.label) + '</span>') +
      '<span class="as-timeline-date">' + esc(formatDate(tp.occurredAt)) + '</span>' +
      (isFirst ? '<span class="as-timeline-flag">First touch</span>' : '') +
      (isLast ? '<span class="as-timeline-flag as-timeline-flag-last">Most recent</span>' : '') +
    '</div>' +
    '<div class="as-timeline-desc">' + describeTouchpointHtml(tp) + '</div>' +
    '<div class="as-timeline-source">' + esc(tp.source) + (duration ? ' · ' + esc(duration) + ' on page' : '') + '</div>' +
    (utm ? '<div class="as-timeline-referrer">' + esc(utm) + '</div>' : '') +
    (tp.referrer ? '<div class="as-timeline-referrer">Referrer: <a href="' + esc(tp.referrer) + '" target="_blank" rel="noopener">' + esc(tp.referrer) + '</a></div>' : '') +
    (clickIds ? '<div class="as-timeline-referrer">' + esc(clickIds) + '</div>' : '')
  );
}

function renderTimeline(container, touchpoints) {
  if (!touchpoints.length) {
    container.innerHTML = '<div class="as-timeline-empty">No touchpoints recorded for this contact.</div>';
    return;
  }

  var groups = groupTouchpoints(touchpoints);
  var total = touchpoints.length;

  var html = '<ol class="as-timeline">' + groups.map(function (g, gi) {
    var isLastRow = gi === groups.length - 1;
    var rail = '<div class="as-timeline-rail"><span class="as-timeline-dot" style="background:' + metaFor('website_visit').color + '"></span>' +
      (isLastRow ? '' : '<span class="as-timeline-line"></span>') +
    '</div>';

    if (g.type === 'single') {
      return '<li class="as-timeline-row">' + rail +
        '<div class="as-timeline-body">' + timelineBodyHtml(g.tp, g.index, total, false) + '</div>' +
      '</li>';
    }

    // Grouped run of website visits.
    var count = g.items.length;
    var totalDuration = formatDuration(sumDurations(g.items));
    var isFirstTouch = g.startIndex === 0;
    var isMostRecent = g.endIndex === total - 1;
    var meta = metaFor('website_visit');
    var subItems = g.items.map(function (tp, idx) {
      return '<li class="as-timeline-subrow">' +
        '<span class="as-timeline-subdot"></span>' +
        '<div class="as-timeline-subbody">' + timelineBodyHtml(tp, g.startIndex + idx, total, true) + '</div>' +
      '</li>';
    }).join('');

    return '<li class="as-timeline-row as-timeline-group">' + rail +
      '<div class="as-timeline-body">' +
        '<div class="as-timeline-meta">' +
          '<span class="as-timeline-badge" style="color:' + meta.color + '">' + esc(meta.label) + '</span>' +
          '<span class="as-timeline-date">' + esc(formatDate(g.items[0].occurredAt)) + ' – ' + esc(formatDate(g.items[g.items.length - 1].occurredAt)) + '</span>' +
          (isFirstTouch ? '<span class="as-timeline-flag">First touch</span>' : '') +
          (isMostRecent ? '<span class="as-timeline-flag as-timeline-flag-last">Most recent</span>' : '') +
        '</div>' +
        '<div class="as-timeline-desc as-timeline-group-toggle" role="button" tabindex="0">' +
          '<span class="as-timeline-group-chevron">▸</span>' + count + ' pages visited' +
        '</div>' +
        '<div class="as-timeline-source">' + (totalDuration ? totalDuration + ' total on site' : '') + '</div>' +
        '<ol class="as-timeline-subgroup">' + subItems + '</ol>' +
      '</div>' +
    '</li>';
  }).join('') + '</ol>';

  container.innerHTML = html;

  container.querySelectorAll('.as-timeline-group-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      toggle.closest('.as-timeline-group').classList.toggle('expanded');
    });
  });
}
