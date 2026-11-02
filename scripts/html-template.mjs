/**
 * Shared HTML shell placeholders for build and dev.
 */

export function fontPreloadTags() {
  return `    <link rel="preload" href="/assets/marketing/fonts/jost-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/marketing/fonts/manrope-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
`;
}

export function fontStylesheetTag() {
  return `    <link rel="stylesheet" href="/assets/marketing/fonts/fonts.css">
`;
}

export function fillTemplate(html, { fontPreloads, fontStylesheet, landingPreload, appStylesheet }) {
  return html
    .replace("<!-- HR_FONT_PRELOADS -->", fontPreloads)
    .replace("<!-- HR_FONT_STYLESHEET -->", fontStylesheet)
    .replace("<!-- HR_LANDING_PRELOAD -->", landingPreload)
    .replace("<!-- HR_APP_STYLESHEET -->", appStylesheet);
}
