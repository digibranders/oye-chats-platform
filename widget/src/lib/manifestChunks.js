// Resolves the files the loader needs from the app build's Vite manifest.
// Shared by the loader build (which bakes the result into the loader) and the
// loader itself (which falls back to fetching the manifest when nothing was
// baked in, e.g. a loader built without the app).

// Every name ends up in `${base}/app/${name}`. A flat, plain filename cannot
// climb out of that directory, so a tampered manifest cannot point the widget
// anywhere else.
export const SAFE_CHUNK_NAME = /^[a-zA-Z0-9._-]+$/

const APP_ENTRY_KEY = 'src/app-entry.jsx'

const assertSafe = (name) => {
  if (typeof name !== 'string' || !SAFE_CHUNK_NAME.test(name)) {
    throw new Error(`manifest has an unsafe filename: ${String(name)}`)
  }
  return name
}

/**
 * @param {Record<string, {file?: string, css?: string[], imports?: string[]}>} manifest
 * @returns {{entry: string, imports: string[], css: string | null}}
 */
export const chunksFromManifest = (manifest) => {
  const entry = manifest?.[APP_ENTRY_KEY]
  if (!entry?.file) throw new Error('manifest missing entry chunk')

  const imports = (entry.imports || []).map((key) => {
    const file = manifest[key]?.file
    if (!file) throw new Error(`manifest entry imports an unknown chunk: ${key}`)
    return assertSafe(file)
  })

  // `entry.css` is set when cssCodeSplit is on; with it off (our build) the
  // stylesheet is the top-level `style.css` entry.
  const css = entry.css?.[0] || manifest['style.css']?.file || null

  return {
    entry: assertSafe(entry.file),
    imports,
    css: css === null ? null : assertSafe(css),
  }
}
