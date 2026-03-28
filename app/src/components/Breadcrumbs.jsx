import { useLocation, Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

const routeLabels = {
    knowledge: 'Sources',
    chatbot: 'My Bots',
    interface: 'Appearance',
    analytics: 'Analytics',
    users: 'Conversations',
    feedback: 'Feedback',
    settings: 'Settings',
    integrations: 'Integrations',
    email: 'Email',
    messages: 'Messages',
    team: 'Team',
    'live-chat': 'Live Chat',
};

export default function Breadcrumbs() {
    const location = useLocation();
    const segments = location.pathname.split('/').filter(Boolean);

    // Root/home page
    if (segments.length === 0) {
        return (
            <span className="text-sm font-medium text-secondary-900 dark:text-white">
                Overview
            </span>
        );
    }

    return (
        <nav className="flex items-center gap-1.5 text-sm">
            <Link to="/" className="text-secondary-400 dark:text-secondary-500 hover:text-secondary-600 dark:hover:text-secondary-300 transition-colors hidden sm:inline">
                Home
            </Link>
            {segments.map((segment, index) => {
                const path = '/' + segments.slice(0, index + 1).join('/');
                const label = routeLabels[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
                const isLast = index === segments.length - 1;

                return (
                    <span key={path} className="flex items-center gap-1.5">
                        <ChevronRight size={14} className="text-secondary-300 dark:text-secondary-600 hidden sm:inline" />
                        {isLast ? (
                            <span className="font-medium text-secondary-900 dark:text-white">{label}</span>
                        ) : (
                            <Link to={path} className="text-secondary-400 dark:text-secondary-500 hover:text-secondary-600 dark:hover:text-secondary-300 transition-colors">
                                {label}
                            </Link>
                        )}
                    </span>
                );
            })}
        </nav>
    );
}
