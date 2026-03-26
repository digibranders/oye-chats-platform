import { WhatsAppIcon } from '../../components/Icons';
import PageHeader from '../../components/ui/PageHeader';
import Badge from '../../components/ui/Badge';

export default function WhatsApp() {
    const inputClass = "w-full px-3.5 py-2.5 bg-white dark:bg-secondary-950 border border-secondary-200 dark:border-secondary-800 rounded-xl text-sm text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all";

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="WhatsApp Integration" subtitle="Connect WhatsApp Business API to your chatbot">
                <Badge variant="neutral">Not Connected</Badge>
            </PageHeader>

            <div className="bg-white dark:bg-secondary-900 rounded-2xl border border-secondary-200 dark:border-secondary-800 shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-500/10 flex items-center justify-center">
                        <WhatsAppIcon className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-secondary-900 dark:text-white">WhatsApp Business API</h3>
                        <p className="text-xs text-secondary-500">Allow your chatbot to interact with users on WhatsApp</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Phone Number ID</label>
                        <input type="text" className={inputClass} placeholder="e.g. 10123456789" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">WhatsApp Business Account ID</label>
                        <input type="text" className={inputClass} placeholder="e.g. 10987654321" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Access Token</label>
                        <input type="password" className={inputClass} placeholder="Permanent or Temporary Access Token" />
                    </div>
                    <div className="pt-2">
                        <button className="px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all">
                            Save Connection
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
