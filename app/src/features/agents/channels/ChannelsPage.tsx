/**
 * Compatibility re-export.
 *
 * The surface is `DeployPage` now — "Channels" was a plural noun over exactly
 * one channel, and the rail, the URL and the page all say Deploy. The old name
 * survives only because `app/routes.tsx` imports it and that file is outside
 * this rebuild's scope; the import should be pointed at `./DeployPage` and this
 * file deleted the next time routing is touched.
 */
export { DeployPage as ChannelsPage } from './DeployPage';
