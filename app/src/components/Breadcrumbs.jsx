import { useLocation, Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

const routeLabels = {
  knowledge: 'Sources',
  chatbot: 'My Bots',
  interface: 'Bot Settings',
  analytics: 'Analytics',
  users: 'Conversations',
  feedback: 'Feedback',
  settings: 'Settings',
  integrations: 'Integrations',
  email: 'Email',
  messages: 'Messages',
  team: 'Team',
  'live-chat': 'Live Chat',
  insights: 'Insights',
  leads: 'Leads',
  qualification: 'Qualification',
  support: 'Support',
};

export default function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    return (
      <span className="text-sm font-medium text-surface-900 dark:text-surface-100">
        Overview
      </span>
    );
  }

  return (
    <nav className="flex items-center gap-1.5 text-sm">
      <Link to="/" className="text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 transition-colors hidden sm:inline">
        Home
      </Link>
      {segments.map((segment, index) => {
        const path = '/' + segments.slice(0, index + 1).join('/');
        const label = routeLabels[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
        const isLast = index === segments.length - 1;

        return (
          <span key={path} className="flex items-center gap-1.5">
            <ChevronRight size={14} className="text-surface-600 dark:text-surface-300 hidden sm:inline" />
            {isLast ? (
              <span className="font-medium text-surface-900 dark:text-surface-100">{label}</span>
            ) : (
              <Link to={path} className="text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
