import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function AccessDenied({ pageName }) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center animate-fade-in">
      <div className="w-14 h-14 rounded-2xl bg-surface-100 dark:bg-surface-800 flex items-center justify-center mb-5">
        <Lock size={26} className="text-surface-400" />
      </div>
      <h2 className="text-lg font-bold text-surface-900 dark:text-white mb-2">
        This area is for workspace owners
      </h2>
      <p className="text-sm text-surface-500 max-w-sm">
        You don&apos;t have permission to access{pageName ? ` ${pageName}` : ' this page'}.
        Contact your workspace owner if you need access.
      </p>
      <button
        onClick={() => navigate('/support')}
        className="mt-6 px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors shadow-sm"
      >
        Go to Support
      </button>
    </div>
  );
}
