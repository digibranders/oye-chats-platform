export default function Tabs({ tabs, activeTab, onChange }) {
    return (
        <div className="flex items-center gap-1 p-1 bg-secondary-100 rounded-xl w-fit">
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                const Icon = tab.icon;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onChange(tab.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            isActive
                                ? 'bg-white text-secondary-900 shadow-sm'
                                : 'text-secondary-500 hover:text-secondary-700:text-secondary-300'
                        }`}
                    >
                        {Icon && <Icon size={15} />}
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}
