import React from 'react';

const QualificationCTA = ({ cta, onSelect, dismissed }) => {
    if (!cta || dismissed || !cta.options?.length) return null;

    return (
        <div
            className="flex flex-wrap gap-2 px-4 pb-2"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
        >
            {cta.options.map((option) => (
                <button
                    key={option}
                    onClick={() => onSelect(option)}
                    className="px-3.5 py-1.5 rounded-full text-[12px] text-gray-600 bg-white border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer"
                >
                    {option}
                </button>
            ))}
        </div>
    );
};

export default QualificationCTA;
