import { Bot, Plus, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getAuthState } from '../utils/auth';

/**
 * Shared empty state shown on pages when no bot is selected or no bots exist.
 *
 * For workspace owners: directs to /chatbot to create a bot.
 * For regular agents: shows a message to contact their workspace owner.
 */
export default function NoBotState({ title, subtitle }) {
    const navigate = useNavigate();
    const { isOperator, isBotManager } = getAuthState();
    const showCreateCta = !isOperator || isBotManager;

    return (
        <div className="flex flex-col items-center justify-center py-20 animate-slide-up">
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-12 flex flex-col items-center text-center max-w-md w-full">
                {/* Icon */}
                <div className="w-20 h-20 rounded-2xl bg-primary-50 flex items-center justify-center mb-6">
                    <Bot size={36} className="text-primary-500" />
                </div>

                {/* Title */}
                <h2 className="text-xl font-bold text-secondary-900 mb-2">
                    {title || 'No Chatbot Yet'}
                </h2>

                {/* Subtitle */}
                <p className="text-secondary-500 mb-8 leading-relaxed">
                    {subtitle || (showCreateCta
                        ? 'Create your first chatbot to get started. You can upload documents, customize the interface, and embed it on your website.'
                        : 'Your workspace owner needs to add a chatbot before this feature is available.'
                    )}
                </p>

                {/* CTA — only for owners / admins */}
                {showCreateCta && (
                    <button
                        onClick={() => navigate('/chatbot')}
                        className="flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-semibold shadow-sm transition-all hover:shadow hover:-translate-y-0.5 active:translate-y-0"
                    >
                        <Plus size={18} />
                        Create Your First Chatbot
                        <ArrowRight size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
