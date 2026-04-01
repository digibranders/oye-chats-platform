import React from 'react';

const SuggestedActions = () => {
    const actions = [
        "Our Services",
        "Work for OyeChats",
        "About us"
    ];

    return (
        <div className="flex flex-wrap gap-2 mt-2">
            {actions.map((action, index) => (
                <button
                    key={index}
                    className="px-4 py-2 bg-white text-[#3A0CA3] text-xs font-medium border border-[#3A0CA3] rounded-full hover:bg-[#3A0CA3] hover:text-white transition-all duration-300 shadow-sm"
                >
                    {action}
                </button>
            ))}
        </div>
    );
};

export default SuggestedActions;
