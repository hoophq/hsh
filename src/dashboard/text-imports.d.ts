/**
 * Type declarations for `*.css` and `*.js` text imports used by
 * src/dashboard/assets.ts. `bun-types` already declares `*.html`
 * (as `HTMLBundle`); we cast that to `string` at the import site.
 * The other two have no Bun-provided shape, so we declare them as
 * plain default-string here.
 */
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
