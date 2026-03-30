import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * Renders an in-place access denied message for agent users visiting owner-only pages.
 *
 * Does NOT redirect — the URL stays as-is so that bookmarks work if the user's
 * role is later elevated and they refresh the page.
 */
export default function AccessDenied({ pageName }) {
    const navigate = useNavigate();

    return (
        <div className="flex flex-col items-center justify-center py-24 px-4 text-center animate-fade-in">
            <div className="w-14 h-14 rounded-2xl bg-secondary-100 flex items-center justify-center mb-5">
                <Lock size={26} className="text-secondary-400" />
            </div>
            <h2 className="text-lg font-bold text-secondary-900 mb-2">
                This area is for workspace owners
            </h2>
            <p className="text-sm text-secondary-500 max-w-sm">
                You don&apos;t have permission to access{pageName ? ` ${pageName}` : ' this page'}.
                Contact your workspace owner if you need access.
            </p>
            <button
                onClick={() => navigate('/support')}
                className="mt-6 px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors"
            >
                Go to Support
            </button>
        </div>
    );
}
