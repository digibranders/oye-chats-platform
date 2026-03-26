import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToast } from '../context/ToastContext';

const icons = {
    success: CheckCircle2,
    error: AlertCircle,
    warning: AlertTriangle,
    info: Info,
};

const styles = {
    success: 'bg-success-50 dark:bg-success-500/10 border-success-500/20 text-success-600 dark:text-success-500',
    error: 'bg-error-50 dark:bg-error-500/10 border-error-500/20 text-error-600 dark:text-error-500',
    warning: 'bg-warning-50 dark:bg-warning-500/10 border-warning-500/20 text-warning-600 dark:text-warning-500',
    info: 'bg-info-50 dark:bg-info-500/10 border-info-500/20 text-info-600 dark:text-info-500',
};

export default function Toast() {
    const { toast, dismissToast } = useToast();
    const Icon = toast ? icons[toast.type] || Info : Info;
    const style = toast ? styles[toast.type] || styles.info : styles.info;

    return (
        <div
            className={`fixed top-5 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg transition-all duration-300 ${
                toast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'
            } ${style}`}
        >
            <Icon size={18} className="shrink-0" />
            <span className="text-sm font-medium">{toast?.message}</span>
            <button
                onClick={dismissToast}
                className="ml-1 p-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
                <X size={14} />
            </button>
        </div>
    );
}
