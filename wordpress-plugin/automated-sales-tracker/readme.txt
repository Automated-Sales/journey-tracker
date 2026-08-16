=== Automated Sales — Prospect Journey Tracker ===
Contributors: automatedsales
Tags: analytics, tracking, pipedrive, attribution, crm
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.2
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Loads the Automated Sales journey-tracking snippet on every page, so
website visits and form-email captures feed into your Pipedrive
attribution data — no code editing required.

== Description ==

This plugin is the WordPress install path for the Automated Sales
Prospect Journey Tracker. Once activated and configured, it enqueues
the shared tracking snippet on every front-end page and identifies
visitors automatically when they submit a form containing an email
field (Contact Form 7, WPForms, Gravity Forms, and plain HTML forms
all work with no extra setup).

It does not talk to WordPress's database or REST API — it only adds
two `<script>` tags to the page footer, pointed at the values from
your `npm run add-tenant` output. All tracking logic and data storage
lives in the separately-hosted journey-tracker API.

= Setup =

1. Activate the plugin.
2. Go to Settings > Automated Sales Tracker.
3. Paste in the three values printed under "1. WEBSITE" when this
   client was onboarded (`npm run add-tenant`): Tracker API URL,
   Tracker key, and the snippet script URL.
4. Save. Tracking starts on the next page load.

= What it doesn't do =

It doesn't inject anything into wp-admin, doesn't run on REST/AJAX/cron
requests, and does nothing at all until all three settings fields are
filled in — there's no risk of a half-configured install breaking a
page.

== Installation ==

1. Upload the `automated-sales-tracker` folder to `/wp-content/plugins/`,
   or install the zip via Plugins > Add New > Upload Plugin.
2. Activate through the 'Plugins' menu in WordPress.
3. Configure under Settings > Automated Sales Tracker as above.

== Changelog ==

= 1.0.0 =
* Initial release: settings page, front-end snippet enqueue, automatic
  form-email detection (inherited from the underlying tracking script).
