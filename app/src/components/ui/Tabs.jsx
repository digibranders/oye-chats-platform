export default function Tabs({ tabs, activeTab, onChange }) {
    return (
        <div className="flex items-center gap-1 p-1 bg-secondary-100 dark:bg-secondary-800 rounded-xl w-fit">
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                const Icon = tab.icon;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onChange(tab.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            isActive
                                ? 'bg-white dark:bg-secondary-700 text-secondary-900 dark:text-white shadow-sm'
                                : 'text-secondary-500 dark:text-secondary-400 hover:text-secondary-700 dark:hover:text-secondary-300'
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
