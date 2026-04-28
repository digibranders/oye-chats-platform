import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid({
  title: "OyeChats — System Design",
  description:
    "Comprehensive system design, architecture, ER diagrams, sequence flows, and capacity analysis for the OyeChats SaaS chatbot platform.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  appearance: false,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#5b6cff" }],
  ],

  themeConfig: {
    siteTitle: "OyeChats · System Design",
    search: { provider: "local" },

    nav: [
      { text: "Overview", link: "/01-context/product-overview" },
      { text: "Architecture", link: "/02-architecture/containers" },
      { text: "Data", link: "/03-data/er-diagram" },
      { text: "Flows", link: "/04-flows/visitor-chat-rag" },
      { text: "Deployment", link: "/07-deployment/topology" },
      { text: "Capacity", link: "/09-capacity/current-limits" },
    ],

    sidebar: [
      {
        text: "1 · Context",
        collapsed: false,
        items: [
          { text: "Product overview", link: "/01-context/product-overview" },
          { text: "System context (C4 L1)", link: "/01-context/system-context" },
          { text: "Personas", link: "/01-context/personas" },
        ],
      },
      {
        text: "2 · Architecture",
        collapsed: false,
        items: [
          { text: "Containers (C4 L2)", link: "/02-architecture/containers" },
          { text: "Components — API", link: "/02-architecture/components-api" },
          { text: "Components — Widget", link: "/02-architecture/components-widget" },
          { text: "Components — Admin", link: "/02-architecture/components-admin" },
          { text: "Tech stack", link: "/02-architecture/tech-stack" },
        ],
      },
      {
        text: "3 · Data",
        collapsed: false,
        items: [
          { text: "ER diagram (full + per domain)", link: "/03-data/er-diagram" },
          { text: "Schema reference", link: "/03-data/schema-reference" },
          { text: "Multi-tenancy strategy", link: "/03-data/multi-tenancy" },
        ],
      },
      {
        text: "4 · Critical flows",
        collapsed: false,
        items: [
          { text: "Signup & onboarding", link: "/04-flows/signup-onboarding" },
          { text: "Document ingestion", link: "/04-flows/document-ingestion" },
          { text: "Visitor chat (RAG)", link: "/04-flows/visitor-chat-rag" },
          { text: "Live chat handoff", link: "/04-flows/live-chat-handoff" },
          { text: "Billing & checkout", link: "/04-flows/billing-checkout" },
          { text: "Credit ledger", link: "/04-flows/credit-ledger" },
          { text: "Webhook delivery", link: "/04-flows/webhook-delivery" },
          { text: "Lead qualification", link: "/04-flows/lead-qualification" },
          { text: "Auth flows", link: "/04-flows/auth-flows" },
        ],
      },
      {
        text: "5 · State machines",
        collapsed: false,
        items: [
          { text: "Chat session", link: "/05-state-machines/chat-session" },
          { text: "Subscription", link: "/05-state-machines/subscription" },
          { text: "Webhook delivery", link: "/05-state-machines/webhook-delivery" },
        ],
      },
      {
        text: "6 · RAG pipeline",
        collapsed: false,
        items: [
          { text: "Ingestion + query DFD", link: "/06-rag/pipeline" },
        ],
      },
      {
        text: "7 · Deployment",
        collapsed: false,
        items: [
          { text: "Production topology", link: "/07-deployment/topology" },
          { text: "CI/CD pipelines", link: "/07-deployment/ci-cd" },
          { text: "Environments", link: "/07-deployment/environments" },
          { text: "External services", link: "/07-deployment/external-services" },
        ],
      },
      {
        text: "8 · Cross-cutting",
        collapsed: false,
        items: [
          { text: "Security", link: "/08-cross-cutting/security" },
          { text: "Observability", link: "/08-cross-cutting/observability" },
          { text: "Reliability", link: "/08-cross-cutting/reliability" },
        ],
      },
      {
        text: "9 · Capacity & scaling",
        collapsed: false,
        items: [
          { text: "Current limits", link: "/09-capacity/current-limits" },
          { text: "Bottlenecks", link: "/09-capacity/bottlenecks" },
          { text: "Scaling plan", link: "/09-capacity/scaling-plan" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/digibranders/oye-chats-platform" },
    ],

    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },

    footer: {
      message: "Internal documentation — OyeChats Platform",
      copyright: "© OyeChats",
    },
  },

  mermaid: {
    theme: "base",
    securityLevel: "loose",
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    themeVariables: {
      // Brand-aligned, high-contrast palette
      primaryColor: "#eef2ff",
      primaryTextColor: "#0f172a",
      primaryBorderColor: "#5b6cff",
      lineColor: "#475569",
      secondaryColor: "#f6f7fb",
      tertiaryColor: "#ffffff",
      // Edge / arrow text
      edgeLabelBackground: "#ffffff",
      // Node text size
      fontSize: "15px",
      // Cluster (subgraph) styling
      clusterBkg: "#fafbff",
      clusterBorder: "#c7d2fe",
      // Notes
      noteBkgColor: "#fff7ed",
      noteTextColor: "#7c2d12",
      noteBorderColor: "#fb923c",
      // Sequence
      actorBkg: "#eef2ff",
      actorBorder: "#5b6cff",
      actorTextColor: "#0f172a",
      activationBkgColor: "#dbeafe",
      activationBorderColor: "#1d4ed8",
      labelBoxBkgColor: "#fff7ed",
      labelBoxBorderColor: "#fb923c",
      labelTextColor: "#7c2d12",
      sequenceNumberColor: "#ffffff",
    },
    flowchart: {
      htmlLabels: true,
      // useMaxWidth=false keeps each diagram at natural size; the pan/zoom wrapper
      // handles overflow. With true, mermaid compresses content into the container
      // and labels get clipped/wrapped mid-word.
      useMaxWidth: false,
      curve: "basis",
      padding: 28,
      nodeSpacing: 70,
      rankSpacing: 90,
      diagramPadding: 24,
      // No wrappingWidth: let nodes be as wide as their longest token. The previous
      // 220px cap was forcing labels with parens/slashes/html-entities to wrap
      // awkwardly mid-token (e.g. "Host page (script\nsrc=cdn...)").
    },
    sequence: {
      useMaxWidth: true,
      showSequenceNumbers: true,
      diagramMarginX: 32,
      diagramMarginY: 16,
      actorMargin: 60,
      width: 170,
      height: 64,
      boxMargin: 12,
      boxTextMargin: 6,
      noteMargin: 12,
      messageMargin: 40,
      mirrorActors: true,
      wrap: true,
    },
    er: {
      // useMaxWidth must be false here: when true, mermaid compresses each entity
      // into the container width and wraps long column names (e.g. "assigned_operator_id")
      // character-by-character. The pan/zoom wrapper handles overflow with scroll/zoom.
      useMaxWidth: false,
      diagramPadding: 28,
      entityPadding: 18,
      minEntityWidth: 220,
      minEntityHeight: 80,
      fontSize: 14,
    },
    state: {
      useMaxWidth: true,
      padding: 14,
      nodeSpacing: 55,
      rankSpacing: 65,
    },
  },

  mermaidPlugin: {
    class: "mermaid-zoomable",
  },
});
