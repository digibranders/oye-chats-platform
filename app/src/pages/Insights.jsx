import { useState } from 'react';
import { BarChart3, MessageCircle, ThumbsUp } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import Analytics from './Analytics';
import Users from './Users';
// import Feedback from './Feedback';

const tabs = [
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'conversations', label: 'Conversations', icon: MessageCircle },
  // { id: 'feedback', label: 'Feedback', icon: ThumbsUp },
];

export default function Insights() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'analytics';
  const [activeTab, setActiveTab] = useState(initialTab);

  return (
    <div className="space-y-4">
      <PageHeader title="Insights" subtitle="Analyze your chatbot's performance and visitor interactions" />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'analytics' && <Analytics embedded />}
      {activeTab === 'conversations' && <Users embedded />}
      {/* {activeTab === 'feedback' && <Feedback embedded />} */}
    </div>
  );
}
