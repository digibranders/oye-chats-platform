import { Mail } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import Badge from '../../components/ui/Badge';

export default function Email() {
    const inputClass = "w-full px-3.5 py-2.5 bg-white border border-secondary-200 rounded-xl text-sm text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all";
    const selectClass = "w-full px-3.5 py-2.5 bg-white border border-secondary-200 rounded-xl text-sm text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all";

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="Email Integration" subtitle="Configure email notifications and outreach">
                <Badge variant="neutral">Not Configured</Badge>
            </PageHeader>

            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-info-50 flex items-center justify-center">
                        <Mail size={20} className="text-info-600" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-secondary-900">Email Configuration</h3>
                        <p className="text-xs text-secondary-500">Set up SMTP or API to send email notifications</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">Provider</label>
                        <select className={selectClass}>
                            <option value="smtp">Custom SMTP</option>
                            <option value="sendgrid">SendGrid</option>
                            <option value="mailgun">Mailgun</option>
                            <option value="aws_ses">Amazon SES</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">SMTP Host</label>
                        <input type="text" className={inputClass} placeholder="e.g. smtp.example.com" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-secondary-700 mb-1.5">SMTP Port</label>
                            <input type="text" className={inputClass} placeholder="e.g. 587" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-secondary-700 mb-1.5">Security</label>
                            <select className={selectClass}>
                                <option value="tls">TLS</option>
                                <option value="ssl">SSL</option>
                                <option value="none">None</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">Username</label>
                        <input type="text" className={inputClass} placeholder="SMTP Username" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">Password</label>
                        <input type="password" className={inputClass} placeholder="SMTP Password" />
                    </div>
                    <div className="pt-2">
                        <button className="px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all">
                            Save Configuration
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
