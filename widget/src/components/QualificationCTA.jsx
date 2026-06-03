import React from 'react';

/**
 * BANT / qualification quick-reply card.
 *
 * Visually anchors a short contextual question (written by the LLM about the
 * answer it just gave) above a row of single-tap options. The question sits
 * between the bot's bubble and the chips so the visitor reads it as a
 * natural follow-up to the answer they just received.
 *
 *   ┌──────────────────────────────────────┐
 *   │ Bot bubble: "Our Pro plan is $49/mo" │
 *   └──────────────────────────────────────┘
 *      Does that fit the monthly budget you're working with?
 *      [ No budget yet ] [ Under $1K/mo ] [ $1K-5K/mo ] [ $5K-20K/mo ] [ $20K+/mo ]
 *
 * Falls back to the static `cta_prompt` configured for the dimension when
 * the LLM omits the [CTA_Q:…] sentinel.
 */
const QualificationCTA = ({ cta, onSelect, dismissed }) => {
    if (!cta || dismissed || !cta.options?.length) return null;

    const prompt = (cta.prompt || '').trim();

    return (
        <div
            className="flex flex-col gap-2 px-4 pb-2 pt-3"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
            data-cta-dimension={cta.dimension || undefined}
        >
            {prompt && (
                <p
                    className="text-[12px] text-gray-500 leading-snug px-0.5 mt-1"
                    role="note"
                >
                    {prompt}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {cta.options.map((option) => (
                    <button
                        key={option}
                        type="button"
                        onClick={() => onSelect(option)}
                        className="px-3.5 py-1.5 rounded-full text-[12px] text-gray-600 bg-white border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer active:scale-[0.98]"
                    >
                        {option}
                    </button>
                ))}
            </div>
        </div>
    );
};

export default QualificationCTA;
