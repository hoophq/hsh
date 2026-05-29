/**
 * Static assets served by the dashboard. Imported as text and stamped
 * into the compiled binary by `bun build --compile` — no separate
 * static-files install path. Verified by hand: import-with-type-text
 * survives the bundler and the assets are available at runtime via
 * normal string access (no Bun.file() needed).
 *
 * If you add a new file under src/dashboard/, also export it from
 * here and serve it from server.ts. We avoid a directory scan because
 * the bundler only walks reachable imports — a scan-and-serve loop
 * would miss assets that aren't statically imported anyway.
 *
 * Why the `as unknown as string` casts
 *
 * `bun-types` declares `*.html` / `*.css` / `*.js` default imports
 * as Bun.HTMLBundle (and similar) so that Bun.serve's route table
 * can typecheck `{ "/": import("./index.html") }`. Our consumer
 * here uses the `with { type: "text" }` attribute, which Bun honours
 * at runtime by returning the raw file string — but TypeScript
 * doesn't differentiate the typed return based on the attribute.
 * Casting is the safest way to keep both Bun.serve's bundle path
 * AND our dashboard's text path on the same module declarations.
 */

import indexHtmlRaw from "./index.html" with { type: "text" };
import stylesCssRaw from "./styles.css" with { type: "text" };
import appJsRaw from "./app.js" with { type: "text" };

export const indexHtml: string = indexHtmlRaw as unknown as string;
export const stylesCss: string = stylesCssRaw as unknown as string;
export const appJs: string = appJsRaw as unknown as string;
