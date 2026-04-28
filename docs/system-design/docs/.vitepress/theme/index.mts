import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { setupMermaidEnhancer } from "./mermaid-enhance";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window !== "undefined") {
      // Run once at boot
      setupMermaidEnhancer();
      // Re-trigger on SPA route changes (VitePress router)
      router.onAfterRouteChange = () => {
        // Defer so the new page's <Mermaid> components have mounted
        window.setTimeout(() => setupMermaidEnhancer(), 0);
      };
    }
  },
} satisfies Theme;
