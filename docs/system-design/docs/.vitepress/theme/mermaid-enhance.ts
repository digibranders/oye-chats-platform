// Client-side enhancement: turn every rendered Mermaid SVG into a pannable / zoomable diagram
// with +, −, reset, and fullscreen controls. Idempotent — safe to call repeatedly.
// svg-pan-zoom is a UMD module that touches `window` at import time, so we lazy-load it client-side only.

const ENHANCED_FLAG = "data-mermaid-enhanced";

const MERMAID_SELECTORS = [
  ".mermaid-zoomable",
  ".mermaid",
  "[class*='language-mermaid']",
];

let panZoomFactoryPromise: Promise<any> | null = null;
function getPanZoom(): Promise<any> {
  if (!panZoomFactoryPromise) {
    panZoomFactoryPromise = import("svg-pan-zoom").then((m: any) => m.default || m);
  }
  return panZoomFactoryPromise;
}

function makeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "oc-mermaid-btn";
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

async function enhanceOne(container: HTMLElement, svg: SVGSVGElement): Promise<void> {
  if (container.getAttribute(ENHANCED_FLAG) === "1") return;
  if (container.closest(".oc-mermaid-wrapper")) {
    container.setAttribute(ENHANCED_FLAG, "1");
    return;
  }
  // Mark immediately so concurrent polls don't double-process
  container.setAttribute(ENHANCED_FLAG, "1");

  const wrapper = document.createElement("div");
  wrapper.className = "oc-mermaid-wrapper";
  // a11y: announce as a region containing a diagram
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute(
    "aria-label",
    "Interactive diagram. Use the controls in the top-right to zoom, reset, or open in fullscreen."
  );
  wrapper.tabIndex = 0;

  const viewport = document.createElement("div");
  viewport.className = "oc-mermaid-viewport";
  viewport.setAttribute("role", "img");
  viewport.setAttribute("aria-label", "Diagram (drag to pan, scroll or double-click to zoom)");

  const parent = container.parentNode;
  if (!parent) {
    container.removeAttribute(ENHANCED_FLAG);
    return;
  }
  parent.insertBefore(wrapper, container);
  viewport.appendChild(container);
  wrapper.appendChild(viewport);

  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  const panZoom = await getPanZoom();
  let instance: any = null;
  try {
    instance = panZoom(svg, {
      zoomEnabled: true,
      controlIconsEnabled: false,
      panEnabled: true,
      fit: true,
      center: true,
      contain: false,
      minZoom: 0.2,
      maxZoom: 10,
      zoomScaleSensitivity: 0.35,
      dblClickZoomEnabled: true,
      mouseWheelZoomEnabled: true,
    });
  } catch {
    return;
  }

  // After auto-fit, very tall diagrams shrink to single-digit % scale (unreadable).
  // We bump zoom modestly only when the auto-fit produced an illegibly tiny scale.
  // Goal: make labels readable while keeping most of the diagram in view.
  const tryBumpZoom = () => {
    try {
      if (!instance) return;
      const sizes = instance.getSizes();
      const realZoom = sizes?.realZoom ?? 1;
      if (realZoom > 0 && realZoom < 0.35) {
        // Don't go higher than 0.55 — keeps the diagram mostly in view
        const target = Math.min(0.55, realZoom * 4);
        const factor = target / realZoom;
        instance.zoomBy(factor);
        instance.center();
      }
    } catch {
      /* ignore */
    }
  };
  window.setTimeout(tryBumpZoom, 120);
  window.setTimeout(tryBumpZoom, 450);

  const controls = document.createElement("div");
  controls.className = "oc-mermaid-controls";
  controls.appendChild(makeButton("+", "Zoom in", () => instance?.zoomIn()));
  controls.appendChild(makeButton("−", "Zoom out", () => instance?.zoomOut()));
  controls.appendChild(
    makeButton("⟲", "Reset", () => {
      instance?.resetZoom();
      instance?.center();
      instance?.fit();
    })
  );

  const exitFullscreen = () => {
    if (!wrapper.classList.contains("oc-mermaid-fullscreen")) return;
    wrapper.classList.remove("oc-mermaid-fullscreen");
    document.body.classList.remove("oc-mermaid-body-locked");
    requestAnimationFrame(() => {
      instance?.resize();
      instance?.fit();
      instance?.center();
    });
  };

  const enterFullscreen = () => {
    wrapper.classList.add("oc-mermaid-fullscreen");
    document.body.classList.add("oc-mermaid-body-locked");
    requestAnimationFrame(() => {
      instance?.resize();
      instance?.fit();
      instance?.center();
    });
  };

  const fullscreenBtn = makeButton("⛶", "Open in fullscreen", () => {
    if (wrapper.classList.contains("oc-mermaid-fullscreen")) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  });
  controls.appendChild(fullscreenBtn);

  // Explicit close button — visible ONLY in fullscreen mode (via CSS), with clear "✕" affordance
  const closeBtn = makeButton("✕", "Close fullscreen", exitFullscreen);
  closeBtn.classList.add("oc-mermaid-btn-close");
  controls.appendChild(closeBtn);

  // Escape key closes fullscreen if this wrapper is the active one
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && wrapper.classList.contains("oc-mermaid-fullscreen")) {
      e.preventDefault();
      exitFullscreen();
    }
  };
  document.addEventListener("keydown", onKey);

  wrapper.appendChild(controls);
}

function enhanceAll(): number {
  if (typeof document === "undefined") return 0;
  let count = 0;
  const seen = new Set<Element>();
  for (const sel of MERMAID_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (el.getAttribute(ENHANCED_FLAG) === "1") return;
      const svg = el.querySelector("svg");
      if (!svg) return;
      // Fire-and-forget; enhanceOne handles its own errors
      enhanceOne(el, svg as SVGSVGElement).catch(() => {});
      count++;
    });
  }
  return count;
}

let intervalHandle: number | null = null;
function pollFor(durationMs: number, intervalMs = 200): void {
  if (typeof window === "undefined") return;
  if (intervalHandle !== null) {
    window.clearInterval(intervalHandle);
  }
  const stopAt = Date.now() + durationMs;
  intervalHandle = window.setInterval(() => {
    enhanceAll();
    if (Date.now() >= stopAt) {
      if (intervalHandle !== null) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
    }
  }, intervalMs);
}

let observerInstalled = false;
function installObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  const obs = new MutationObserver(() => {
    enhanceAll();
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

export function setupMermaidEnhancer(): void {
  if (typeof window === "undefined") return;
  const run = () => {
    enhanceAll();
    pollFor(6000, 200);
    installObserver();
  };
  if (document.readyState === "complete" || document.readyState === "interactive") {
    run();
  } else {
    window.addEventListener("DOMContentLoaded", run);
  }
}
