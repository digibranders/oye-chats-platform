import { Mail } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import Badge from '../../components/ui/Badge';

export default function Email() {
    return (
        <div className="space-y-6 max-w-3xl">
            <PageHeader title="Email Integration" subtitle="Configure email notifications and outreach">
                <Badge variant="neutral">Coming Soon</Badge>
            </PageHeader>

            <div className="bg-white rounded-2xl border border-surface-200 shadow-sm p-12">
                <div className="flex flex-col items-center justify-center text-center">
                    <div className="w-14 h-14 rounded-2xl bg-sky-50 flex items-center justify-center mb-4">
                        <Mail size={28} className="text-sky-600" />
                    </div>
                    <h3 className="text-lg font-semibold text-surface-900 mb-2">
                        Email Integration Coming Soon
                    </h3>
                    <p className="text-sm text-surface-500 max-w-sm leading-relaxed">
                        We are working on SMTP and email API integrations so you can send notifications, lead alerts, and follow-ups directly from OyeChats. Stay tuned!
                    </p>
                </div>
            </div>
        </div>
    );
}
