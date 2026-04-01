# Admin Dashboard

The admin dashboard is a React SPA where customers manage their bots, knowledge base, analytics, and live chat operators.

## Stack

- **React 19** with Vite 8
- **React Router 7** for navigation
- **Recharts 2.15** for analytics charts
- **react-colorful** for color pickers (bot theming)
- **react-easy-crop** for image cropping (logo uploads)

## Running Locally

```bash
cd admin
npm install
cp .env.example .env    # Configure API URL
npm run dev             # → http://localhost:5174
```

## Pages & Features

### Bot Management (`Chatbot.jsx`)

The primary page where customers manage their chatbot instances.

**Tabs:**

1. **Bots** — CRUD operations for bot instances
   - Create a new bot (optionally crawl a website during setup)
   - View all bots with masked bot keys
   - Edit bot settings (opens the Interface page)
   - Delete bots with confirmation dialog
   - Copy bot key to clipboard
   - View and copy embed script

2. **Appearance** — Visual customization
   - Redirects to the Interface page for the selected bot

**Embed Script Generation:**

The dashboard generates the embed snippet for each bot:
```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

This is displayed in an expandable section with a copy button.

### Bot Settings / Interface (`Interface.jsx`)

Full configuration editor for a single bot:

- **Identity:** Name, website, system prompt
- **Appearance:** Colors (primary, header, user bubble), logo upload with cropping, avatar type
- **Lead Capture:** Enable/disable, choose which fields to collect (name, email, phone, company)
- **BANT Qualification:** Enable/disable sales qualification, notification email
- **Live Chat:** Enable/disable operator handoff, timeout settings, business hours
- **Integrations:** Platform-specific setup (Slack, Teams, WhatsApp)

### Knowledge Base / Documents

Manage the bot's document library:

- **Upload:** Drag-and-drop PDF, DOCX, or TXT files
- **Web Crawl:** Enter a URL to scrape and ingest
- **View:** List all ingested documents with metadata
- **Delete:** Remove documents and their embeddings

### Analytics Dashboard

Visual analytics powered by Recharts:

- **Dashboard Summary:** Total conversations, messages, unique visitors, avg. session length
- **Activity Chart:** Conversations over time
- **Top Questions:** Most frequently asked questions
- **Visitor Insights:** Device types, locations, session distribution
- **Feedback:** Thumbs up/down distribution across messages

### Operators & Live Chat

Manage the live chat team:

- **Operators:** CRUD for team members (name, email, role, department)
- **Departments:** Create and manage routing departments
- **Canned Responses:** Pre-saved reply templates

### Leads

View and manage captured leads:

- **List:** All leads with contact info and qualification status
- **Detail:** Full lead profile with chat session history
- **Update:** Change qualification status

### Settings (`/client`)

Account-level settings:

- **Profile:** Update account name, email
- **API Key:** View and regenerate the client API key

## Context Providers

The admin app uses React Context for global state:

| Context | Purpose |
|---------|---------|
| `AuthContext` | User authentication state, login/logout |
| `BotContext` | Selected bot, bot list, refresh logic |
| `ToastContext` | Toast notification management |

## API Integration

The admin's API service (`admin/src/services/api.js`) wraps all backend calls with the `X-API-Key` header. All requests go through this service layer.

## Platform Integrations

The admin includes setup guides for embedding on specific platforms:

| Platform | Component |
|----------|-----------|
| Generic HTML | Direct script tag |
| WordPress | Plugin or theme header injection |
| Shopify | Theme liquid snippet |
| Webflow | Custom code embed |
| Next.js/React | Script component |
| Slack | Bot integration (via `PlatformSelector`) |
| Microsoft Teams | Bot integration |
| WhatsApp | Business API integration |

## Key Files

| Purpose | Path |
|---------|------|
| Bot management page | `admin/src/pages/Chatbot.jsx` |
| Bot settings editor | `admin/src/pages/Interface.jsx` |
| API service | `admin/src/services/api.js` |
| Auth context | `admin/src/context/AuthContext.jsx` |
| Bot context | `admin/src/context/BotContext.jsx` |
| Vite config | `admin/vite.config.js` |
