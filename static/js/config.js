/*
 * Site configuration for the Honeycomb-Surfels project page (classic script, loaded first).
 *
 * MEDIA_BASE_URL_PUBLIC: public URL of the media bucket, without a trailing slash, for example
 *   "https://pub-<hash>.r2.dev". Leave it empty until the media is hosted; the page then shows a
 *   notice instead of videos. MEDIA_BASE_URL_LOCAL is used on localhost, 127.0.0.1 and file: pages,
 *   where a ?media=<url> query parameter overrides it; the published page always uses
 *   MEDIA_BASE_URL_PUBLIC (see static/js/media.js).
 * MEDIA_VERSION: appended to media URLs as ?v=<version>; bump it after re-uploading changed media.
 * LINKS: a null link renders as a disabled button with a "soon" tag.
 * AUTHORS: a null url renders the name as plain text; equal marks equal contribution (*).
 * AFFILIATION: the parts of the affiliation line, joined with commas; a part without url is plain text.
 * STATS_ENDPOINT: URL of the visitor counter Worker in stats/ (read by static/js/visitors.js). While it is
 *   null the footer shows no counter and the page sends no request for it.
 * GOATCOUNTER_URL: count endpoint of a GoatCounter site, "https://<code>.goatcounter.com/count", for the authors'
 *   own dashboard of visits by country, page and date; nothing appears on the page. While it is null nothing loads.
 */
window.HEXELS_CONFIG = {
  MEDIA_BASE_URL_PUBLIC: "https://pub-c45189ae5c7b4323bf573acdcd18ab1b.r2.dev",
  MEDIA_BASE_URL_LOCAL: "media_build",
  MEDIA_VERSION: "1",
  LINKS: { paper: null, arxiv: null, code: null, video: null },
  AUTHORS: [
    { id: "kaushik", name: "Prakhar Kaushik", url: "https://toshi2k2.github.io/", equal: true },
    { id: "paul", name: "Soumava Paul", url: "https://mvp18.github.io/", equal: true },
    { id: "yuille", name: "Alan Yuille", url: "https://www.cs.jhu.edu/~ayuille1/", equal: false },
  ],
  AFFILIATION: [
    { name: "CCVL", url: "https://ccvl.jhu.edu/" },
    { name: "Johns Hopkins University", url: "https://www.jhu.edu/" },
  ],
  STATS_ENDPOINT: null,
  GOATCOUNTER_URL: null,
};
