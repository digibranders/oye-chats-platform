import { Mail } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import Badge from '../../components/ui/Badge';

export default function Email() {
    return (
        <div className="space-y-6 max-w-3xl">
            <PageHeader title="Email Integration" subtitle="Configure email notifications and outreach">
                <Badge variant="neutral">Coming Soon</Badge>
            </PageHeader>

            <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm p-12">
                <div className="flex flex-col items-center justify-center text-center">
                    <div className="w-14 h-14 rounded-2xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
                        <Mail size={28} className="text-primary-600 dark:text-primary-400" />
                    </div>
                    <h3 className="text-lg font-semibold text-surface-900 dark:text-surface-50 mb-2">
                        Email Integration Coming Soon
                    </h3>
                    <p className="text-sm text-surface-500 dark:text-surface-400 max-w-sm leading-relaxed">
                        We are working on SMTP and email API integrations so you can send notifications, lead alerts, and follow-ups directly from OyeChats. Stay tuned!
                    </p>
                </div>
            </div>
        </div>
    );
}
