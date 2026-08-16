___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Automated Sales - Prospect Journey Tracker",
  "categories": ["MARKETING", "ANALYTICS"],
  "description": "Loads the Automated Sales prospect-journey tracking snippet (website visits + form-email identification) and sends events to your tenant's journey-tracker API.",
  "containerContexts": ["WEB"]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "apiUrl",
    "displayName": "Tracker API URL",
    "simpleValueType": true,
    "valueHint": "https://journey-api.yourdomain.com/t/acme-co",
    "help": "The AS_TRACKER_API_URL value printed by 'npm run add-tenant' for this client (includes the /t/<slug> path — one per client).",
    "valueValidators": [
      { "type": "NON_EMPTY" }
    ]
  },
  {
    "type": "TEXT",
    "name": "trackKey",
    "displayName": "Tracker key",
    "simpleValueType": true,
    "valueHint": "the trackKey printed for this client",
    "help": "The AS_TRACKER_KEY value printed by 'npm run add-tenant' for this client. Treat it like a secret — anyone with it can post tracking events for this tenant.",
    "valueValidators": [
      { "type": "NON_EMPTY" }
    ]
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const injectScript = require('injectScript');
const setInWindow = require('setInWindow');
const logToConsole = require('logToConsole');

// Fixed by this template (see ___WEB_PERMISSIONS___ below, which allow-lists
// this exact URL). If you host the snippet somewhere else, update both the
// value here AND the inject_script permission URL in the template editor's
// Permissions tab, or the tag will fail with a permission error instead of
// silently loading the wrong script.
const scriptUrl = 'https://YOUR-DEPLOYED-API-HOST/automated-sales-tracker.js';

setInWindow('AS_TRACKER_API_URL', data.apiUrl, true);
setInWindow('AS_TRACKER_KEY', data.trackKey, true);

injectScript(
  scriptUrl,
  data.gtmOnSuccess,
  function () {
    logToConsole('Automated Sales tracker: failed to load ' + scriptUrl);
    data.gtmOnFailure();
  },
  scriptUrl
);


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "access_globals",
        "versionId": "1"
      },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "AS_TRACKER_API_URL" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  { "type": 1, "string": "key" },
                  { "type": 1, "string": "read" },
                  { "type": 1, "string": "write" },
                  { "type": 1, "string": "execute" }
                ],
                "mapValue": [
                  { "type": 1, "string": "AS_TRACKER_KEY" },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": true },
                  { "type": 8, "boolean": false }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "inject_script",
        "versionId": "1"
      },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://YOUR-DEPLOYED-API-HOST/automated-sales-tracker.js"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

UNVERIFIED — built by hand from Google's documented Sandboxed JS API
(injectScript, setInWindow) and the internal ___WEB_PERMISSIONS___ JSON
structure confirmed against real, working community templates on GitHub
(kompassify-gtm-template, hyvor-talk-tag-manager-template), but this exact
file has NOT been imported into a live GTM container. Before rolling out
to a client:

  1. Before importing: replace both occurrences of
     "YOUR-DEPLOYED-API-HOST" (the scriptUrl constant in the JS, and the
     inject_script permission URL below it) with your actual deployed
     API host — do this in a text editor first, since the permission URL
     must match the JS exactly or GTM will block the injectScript call.
  2. GTM > Templates > New > Import (the "..." menu) > select this file.
  3. Create a tag from it, fill in the two client-specific fields
     (Tracker API URL, Tracker key — same values as the Custom HTML
     path, from `npm run add-tenant`), set trigger to All Pages.
  4. Preview mode: confirm the tag fires and
     window.AS_TRACKER_API_URL / window.AS_TRACKER_KEY are set (Preview
     > pick the page > Console), and that a network call to
     .../api/track goes out.

If step 4 doesn't work, fall back to custom-html-tag.html (Option A) —
it has no import step and is guaranteed to work since it's just a
standard Custom HTML tag.
