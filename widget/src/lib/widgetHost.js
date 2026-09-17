// The widget's shadow host and stylesheet. Created by whichever runs first, the
// loader or the app, so the stylesheet downloads alongside the app scripts
// rather than after them.

export const CONTAINER_ID = 'oyechats-widget-root'

const STYLE_LINK_ATTR = 'data-oyechats-style'
const STYLE_STATE_ATTR = 'data-oyechats-style-state'

// Mirrors the `:host` rule in index.css, applied inline so the host is out of
// the page flow before that stylesheet arrives. Without it the host sat in the
// customer's layout until the stylesheet loaded, and the page shifted.
const HOST_STYLE = [
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['width', '0'],
  ['height', '0'],
  ['overflow', 'visible'],
  ['z-index', '2147483647'],
  ['pointer-events', 'none'],
]

/** @returns {{host: HTMLElement, shadow: ShadowRoot}} */
export const ensureHost = (doc = document) => {
  let host = doc.getElementById(CONTAINER_ID)
  if (!host) {
    host = doc.createElement('div')
    host.id = CONTAINER_ID
    doc.body.appendChild(host)
  }
  for (const [prop, value] of HOST_STYLE) host.style.setProperty(prop, value, 'important')
  // Opts the subtree out of Lenis smooth-scroll hijacking: wheel events that
  // cross the shadow boundary are retargeted to this host, where Lenis looks.
  host.setAttribute('data-lenis-prevent', '')
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
  return { host, shadow }
}

/** @returns {HTMLLinkElement} */
export const ensureStylesheet = (shadow, href) => {
  const existing = shadow.querySelector(`link[${STYLE_LINK_ATTR}="1"]`)
  if (existing) return existing
  const link = shadow.ownerDocument.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.setAttribute(STYLE_LINK_ATTR, '1')
  // Recorded on the element because the app may attach its own listeners
  // after the load or error event has already fired.
  link.setAttribute(STYLE_STATE_ATTR, 'loading')
  link.addEventListener('load', () => link.setAttribute(STYLE_STATE_ATTR, 'loaded'), { once: true })
  link.addEventListener('error', () => link.setAttribute(STYLE_STATE_ATTR, 'error'), { once: true })
  shadow.appendChild(link)
  return link
}

/**
 * Resolves once the stylesheet applies and rejects if it failed. Rendering
 * before that draws the widget as unstyled buttons inside the customer's page.
 */
export const whenStylesheetReady = (link) => new Promise((resolve, reject) => {
  const failed = () => new Error(`widget stylesheet failed to load: ${link.href}`)
  const state = link.getAttribute(STYLE_STATE_ATTR)
  if (state === 'loaded' || (state === null && link.sheet)) {
    resolve()
    return
  }
  if (state === 'error') {
    reject(failed())
    return
  }
  link.addEventListener('load', () => resolve(), { once: true })
  link.addEventListener('error', () => reject(failed()), { once: true })
})
