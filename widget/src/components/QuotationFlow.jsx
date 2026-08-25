import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, SkipForward, Check } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';
import {
    submitQuotationServices,
    submitQuotationAnswer,
    submitQuotationQuantity,
    acceptQuotation,
    skipQuotation,
    submitLeadCapture,
} from '../services/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Visitor-facing quotation card. Drives the backend state machine end-to-end:
 * selecting services → per-service questions → per-service quantity (silent,
 * defaults are applied automatically — no pricing or quantities are ever
 * shown to the visitor) → email capture → done. Pricing/quantities still
 * live server-side for the admin's Lead detail view; this card just never
 * surfaces them to the visitor.
 */
const QuotationFlow = ({ sessionId, settings, initialState, onComplete }) => {
    const [state, setState] = useState(initialState || null);
    const [answer, setAnswer] = useState('');
    const [selectedOptions, setSelectedOptions] = useState(() => new Set());
    const [email, setEmail] = useState('');
    const [selectedIds, setSelectedIds] = useState(
        () => new Set(initialState?.selected_service_ids || []),
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const primaryColor = useMemo(
        () => sanitizeColor(settings?.primary_color, '#3A0CA3'),
        [settings?.primary_color],
    );

    const finish = useCallback(
        (finalStatus, extras = {}) => {
            if (typeof onComplete === 'function') {
                onComplete({ status: finalStatus, ...extras });
            }
        },
        [onComplete],
    );

    // ── Skip ──────────────────────────────────────────────────────────────
    const handleSkip = useCallback(async () => {
        if (submitting) return;
        setSubmitting(true);
        try {
            await skipQuotation(sessionId);
            finish('skipped');
        } finally {
            setSubmitting(false);
        }
    }, [submitting, sessionId, finish]);

    // ── Step 1: selecting services ────────────────────────────────────────
    const toggleService = (id) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const submitSelection = useCallback(async () => {
        if (submitting) return;
        if (selectedIds.size === 0) {
            setError('Pick at least one service, or click Skip to talk to us directly.');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            const next = await submitQuotationServices(sessionId, Array.from(selectedIds));
            setAnswer('');
            setState(next);
            if (!next.active) finish(next.status || 'complete', { total: next.total, quote: next.quote });
        } catch (err) {
            console.error('[OyeChats] quotation select failed', err);
            setError('Something went wrong. Please try again.');
        } finally {
            setSubmitting(false);
        }
    }, [submitting, selectedIds, sessionId, finish]);

    // ── Step 2: answering per-service questions ────────────────────────────
    const current = state?.current || null;
    const isQuantityStep = !!current && !current.question;

    const submitCurrent = useCallback(
        async (event) => {
            if (event) event.preventDefault();
            if (!current || !current.question || submitting) return;
            setError('');
            setSubmitting(true);
            try {
                const isChoice = current.question.type === 'choice';
                const trimmed = isChoice
                    ? Array.from(selectedOptions).join(', ')
                    : (answer || '').trim();
                if (current.question.required && !trimmed) {
                    setError(isChoice ? 'Pick at least one option.' : 'This field is required.');
                    setSubmitting(false);
                    return;
                }
                if (current.question.type === 'number' && trimmed && Number.isNaN(Number(trimmed))) {
                    setError('Please enter a number.');
                    setSubmitting(false);
                    return;
                }
                const next = await submitQuotationAnswer(
                    sessionId,
                    current.id,
                    current.question.id,
                    trimmed,
                );
                setAnswer('');
                setSelectedOptions(new Set());
                setState(next);
                if (!next.active) finish(next.status || 'complete', { total: next.total, quote: next.quote });
            } catch (err) {
                console.error('[OyeChats] quotation step failed', err);
                setError('Something went wrong. Please try again.');
            } finally {
                setSubmitting(false);
            }
        },
        [answer, selectedOptions, current, submitting, sessionId, finish],
    );

    // ── Step 3: quantity — never shown to the visitor. Apply the admin's
    // default quantity automatically as soon as this step is reached. ─────
    const autoQuantitySubmittedRef = useRef(new Set());
    useEffect(() => {
        if (!isQuantityStep || !current) return;
        if (autoQuantitySubmittedRef.current.has(current.id)) return;
        autoQuantitySubmittedRef.current.add(current.id);
        const qty = Math.max(0, Math.floor(Number(current.default_quantity) || 1));
        submitQuotationQuantity(sessionId, current.id, qty)
            .then((next) => {
                setState(next);
                if (!next.active) finish(next.status || 'complete', { total: next.total, quote: next.quote });
            })
            .catch((err) => {
                console.error('[OyeChats] quotation auto-quantity failed', err);
                setError('Something went wrong. Please try again.');
            });
    }, [isQuantityStep, current, sessionId, finish]);

    // ── Step 4: email capture → accept ──────────────────────────────────────
    const handleGetQuote = useCallback(
        async (event) => {
            if (event) event.preventDefault();
            if (submitting) return;
            const trimmed = (email || '').trim();
            if (!EMAIL_RE.test(trimmed)) {
                setError('Please enter a valid email address.');
                return;
            }
            setError('');
            setSubmitting(true);
            try {
                await submitLeadCapture(sessionId, { email: trimmed });
                const next = await acceptQuotation(sessionId);
                setState(next);
                finish('complete', { total: next.total, quote: next.quote, email: trimmed });
            } catch (err) {
                console.error('[OyeChats] quotation email capture failed', err);
                setError('Something went wrong. Please try again.');
            } finally {
                setSubmitting(false);
            }
        },
        [submitting, email, sessionId, finish],
    );

    // ── Layout ────────────────────────────────────────────────────────────
    if (!state) return null;

    const cardStyle = {
        border: `1px solid ${primaryColor}22`,
        borderRadius: '12px',
        padding: '14px',
        margin: '8px 0',
        background: '#ffffff',
    };
    const headerRow = (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {state.status === 'selecting' ? 'Build your quote' :
                    state.status === 'answering' && current?.question ? `${current.name} · Q${current.question_index + 1}/${current.question_total}` :
                    state.status === 'quoting' ? 'Get your quotation' : 'Quotation'}
            </span>
            <button
                type="button"
                onClick={handleSkip}
                disabled={submitting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'transparent', border: 'none', color: '#6b7280', fontSize: '12px', cursor: submitting ? 'not-allowed' : 'pointer', padding: 0 }}
                aria-label="Skip quotation and talk to team"
            >
                <SkipForward size={12} /> Skip
            </button>
        </div>
    );
    const errorLine = error ? (
        <p style={{ color: '#dc2626', fontSize: '12px', marginTop: '6px', marginBottom: 0 }}>{error}</p>
    ) : null;
    const primaryButtonStyle = {
        marginTop: '12px', width: '100%', padding: '10px 12px', borderRadius: '8px',
        border: 'none', background: primaryColor, color: '#ffffff', fontSize: '14px',
        fontWeight: 500, cursor: submitting ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        opacity: submitting ? 0.7 : 1,
    };
    const inputStyle = {
        width: '100%', padding: '10px 12px', borderRadius: '8px',
        border: '1px solid #e5e7eb', fontSize: '14px', outline: 'none',
    };

    // Step 1: select services (no pricing shown)
    if (state.status === 'selecting') {
        return (
            <div className="oyechats-quotation" style={cardStyle}>
                {headerRow}
                <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 10px' }}>
                    Which of these do you want a quote for?
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(state.services || []).map((service) => {
                        const active = selectedIds.has(service.id);
                        return (
                            <button
                                key={service.id}
                                type="button"
                                onClick={() => toggleService(service.id)}
                                disabled={submitting}
                                style={{
                                    textAlign: 'left',
                                    padding: '10px 12px',
                                    borderRadius: '8px',
                                    border: active ? `2px solid ${primaryColor}` : '1px solid #e5e7eb',
                                    background: active ? `${primaryColor}0d` : '#ffffff',
                                    color: '#111827',
                                    fontSize: '13px',
                                    cursor: submitting ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    style={{
                                        width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0,
                                        border: `2px solid ${active ? primaryColor : '#d1d5db'}`,
                                        background: active ? primaryColor : '#ffffff',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                    }}
                                >
                                    {active && <Check size={11} color="#ffffff" strokeWidth={3} />}
                                </span>
                                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                                    <span style={{ fontWeight: 500 }}>{service.name}</span>
                                    {service.description && (
                                        <span style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>{service.description}</span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
                {errorLine}
                <button type="button" onClick={submitSelection} disabled={submitting} style={primaryButtonStyle}>
                    {submitting ? 'Loading...' : 'Continue'} <ArrowRight size={14} />
                </button>
            </div>
        );
    }

    // Step 2: answering questions (quantity step is silent — no UI)
    if (state.status === 'answering' && current) {
        if (isQuantityStep) return null;

        return (
            <div className="oyechats-quotation" style={cardStyle}>
                {headerRow}
                <div style={{ height: '3px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
                    <div
                        style={{
                            height: '100%',
                            width: `${Math.round(((current.service_index + 1) / current.service_total) * 100)}%`,
                            background: primaryColor,
                            transition: 'width 200ms ease',
                        }}
                    />
                </div>

                <form onSubmit={submitCurrent}>
                    <label style={{ display: 'block', fontSize: '14px', color: '#111827', fontWeight: 500, marginBottom: '10px' }}>
                        {current.question.text}
                    </label>

                    {current.question.type === 'choice' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {current.question.options.map((opt) => {
                                const active = selectedOptions.has(opt);
                                return (
                                    <button
                                        key={opt}
                                        type="button"
                                        onClick={() => {
                                            setSelectedOptions((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(opt)) next.delete(opt);
                                                else next.add(opt);
                                                return next;
                                            });
                                            if (error) setError('');
                                        }}
                                        disabled={submitting}
                                        style={{
                                            textAlign: 'left', padding: '9px 12px', borderRadius: '8px',
                                            border: active ? `2px solid ${primaryColor}` : '1px solid #e5e7eb',
                                            background: active ? `${primaryColor}0d` : '#ffffff',
                                            color: '#111827', fontSize: '13px',
                                            cursor: submitting ? 'not-allowed' : 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '10px',
                                        }}
                                    >
                                        <span
                                            aria-hidden="true"
                                            style={{
                                                width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0,
                                                border: `2px solid ${active ? primaryColor : '#d1d5db'}`,
                                                background: active ? primaryColor : '#ffffff',
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                            }}
                                        >
                                            {active && <Check size={11} color="#ffffff" strokeWidth={3} />}
                                        </span>
                                        <span>{opt}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <input
                            type={current.question.type === 'number' ? 'number' : 'text'}
                            value={answer}
                            onChange={(e) => { setAnswer(e.target.value); if (error) setError(''); }}
                            disabled={submitting}
                            autoFocus
                            placeholder="Type your answer..."
                            style={inputStyle}
                        />
                    )}
                    {errorLine}
                    <button type="submit" disabled={submitting} style={primaryButtonStyle}>
                        {submitting ? 'Sending...' : 'Continue'} <ArrowRight size={14} />
                    </button>
                </form>
            </div>
        );
    }

    // Step 4: email capture. No pricing is ever shown to the visitor here —
    // the quote itself (with pricing) is computed and stored server-side for
    // the admin's Lead detail view, not surfaced in the widget.
    if (state.status === 'quoting') {
        return (
            <div className="oyechats-quotation" style={cardStyle}>
                {headerRow}
                <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 10px' }}>
                    Enter your email and we&apos;ll get your quotation ready.
                </p>
                <form onSubmit={handleGetQuote}>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                        disabled={submitting}
                        autoFocus
                        placeholder="you@company.com"
                        style={inputStyle}
                    />
                    {errorLine}
                    <button type="submit" disabled={submitting} style={primaryButtonStyle}>
                        <Check size={14} /> {submitting ? 'Sending...' : 'Get my quotation'}
                    </button>
                </form>
            </div>
        );
    }

    return null;
};

export default QuotationFlow;
