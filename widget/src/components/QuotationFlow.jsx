import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, SkipForward, Check } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';
import {
    submitQuotationServices,
    submitQuotationRequirements,
    acceptQuotation,
    skipQuotation,
    submitLeadCapture,
    validateEmail as checkEmailWithServer,
} from '../services/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Visitor-facing quotation card. Drives the backend state machine end-to-end:
 * selecting a service → choosing which of its requirements apply → email
 * capture → done. Pricing is never shown to the visitor; it is computed and
 * stored server-side for the admin's Lead detail view and the emailed
 * quotation PDF.
 */
const QuotationFlow = ({ sessionId, settings, initialState, onComplete }) => {
    const [state, setState] = useState(initialState || null);
    const [checkedItems, setCheckedItems] = useState(() => new Set());
    const [choicePicks, setChoicePicks] = useState({});
    const [askQty, setAskQty] = useState({});
    const [reqIndex, setReqIndex] = useState(0);
    const [email, setEmail] = useState('');
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
        } catch (err) {
            // Skip is the escape hatch. Whatever the server said, the visitor
            // asked to leave the flow, so close it locally rather than trapping
            // them in a card with no way out.
            console.error('[OyeChats] quotation skip failed', err);
        } finally {
            finish('skipped');
            setSubmitting(false);
        }
    }, [submitting, sessionId, finish]);

    // ── Step 1: pick a service ────────────────────────────────────────────
    // Single-select: tapping a service immediately submits just that one and
    // moves straight into its requirements.
    const submitSelection = useCallback(async (serviceId) => {
        if (submitting || !serviceId) return;
        setError('');
        setSubmitting(true);
        try {
            const next = await submitQuotationServices(sessionId, [serviceId]);
            setState(next);
            if (!next.active) finish(next.status || 'complete', { total: next.total, quote: next.quote });
        } catch (err) {
            console.error('[OyeChats] quotation select failed', err);
            setError('Something went wrong. Please try again.');
        } finally {
            setSubmitting(false);
        }
    }, [submitting, sessionId, finish]);

    // ── Step 2: choose requirements ───────────────────────────────────────
    const current = state?.current || null;

    // Reset the checklist whenever the visitor lands on a new service.
    useEffect(() => {
        setCheckedItems(new Set());
        setChoicePicks({});
        setAskQty({});
        setReqIndex(0);
    }, [current?.service_id]);

    const setAskQuantity = (reqId, value) => {
        const n = Math.max(0, Math.min(100000, Math.floor(Number(value) || 0)));
        setAskQty((prev) => ({ ...prev, [reqId]: n }));
        if (error) setError('');
    };

    const toggleItem = (id) => {
        setCheckedItems((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        if (error) setError('');
    };

    // Choice requirements are pick-at-most-one: tapping the selected option
    // again deselects it (the whole question is optional).
    const pickOption = (reqId, optionId) => {
        setChoicePicks((prev) => {
            const next = { ...prev };
            if (next[reqId] === optionId) delete next[reqId];
            else next[reqId] = optionId;
            return next;
        });
        if (error) setError('');
    };

    const submitRequirements = useCallback(async (event) => {
        if (event) event.preventDefault();
        if (submitting || !current) return;
        const selections = [];
        for (const req of current.requirements || []) {
            if (req.quantity_mode === 'ask') {
                const qty = Math.max(0, Math.floor(Number(askQty[req.id]) || 0));
                if (qty <= 0) continue;
                if (req.type === 'choice') {
                    const opt = choicePicks[req.id];
                    if (opt) selections.push({ requirement_id: req.id, option_id: opt, quantity: qty });
                } else {
                    selections.push({ requirement_id: req.id, quantity: qty });
                }
            } else if (req.type === 'choice') {
                const opt = choicePicks[req.id];
                if (opt) selections.push({ requirement_id: req.id, option_id: opt });
            } else if (checkedItems.has(req.id)) {
                selections.push({ requirement_id: req.id });
            }
        }
        if (selections.length === 0) {
            setError('Pick at least one, or click Skip to talk to us directly.');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            const next = await submitQuotationRequirements(sessionId, current.service_id, selections);
            setState(next);
            if (!next.active) finish(next.status || 'complete', { total: next.total, quote: next.quote });
        } catch (err) {
            console.error('[OyeChats] quotation requirements failed', err);
            setError('Something went wrong. Please try again.');
        } finally {
            setSubmitting(false);
        }
    }, [submitting, current, checkedItems, choicePicks, askQty, sessionId, finish]);

    // ── Step 3: email capture → accept ──────────────────────────────────────
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
                // Server-side deliverability check, same gate the lead-capture,
                // handoff and offline forms already apply. This was the one
                // visitor form that skipped it, and it is the form whose address
                // gets emailed a priced quotation. ``validateEmail`` fails OPEN
                // (an unreachable vendor resolves ``valid: true``), so a real
                // lead is never rejected because the checker is down.
                const verdict = await checkEmailWithServer(trimmed);
                if (!verdict.valid) {
                    setError(verdict.reason || 'Please enter a valid email address.');
                    return;  // the `finally` below clears `submitting`
                }
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
                    state.status === 'choosing' && current ? `${current.name} · Requirements` :
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
    const checkboxRowStyle = (active) => ({
        textAlign: 'left', padding: '10px 12px', borderRadius: '8px',
        border: active ? `2px solid ${primaryColor}` : '1px solid #e5e7eb',
        background: active ? `${primaryColor}0d` : '#ffffff',
        color: '#111827', fontSize: '13px',
        cursor: submitting ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', gap: '10px',
    });
    const checkboxBoxStyle = (active) => ({
        width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0,
        border: `2px solid ${active ? primaryColor : '#d1d5db'}`,
        background: active ? primaryColor : '#ffffff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    });
    const radioBoxStyle = (active) => ({
        width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${active ? primaryColor : '#d1d5db'}`,
        background: '#ffffff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    });
    const radioDotStyle = { width: '8px', height: '8px', borderRadius: '50%', background: primaryColor };

    // Step 1: pick a service — single-select, tap to go straight into it.
    // No pricing shown.
    if (state.status === 'selecting') {
        return (
            <div className="oyechats-quotation" style={cardStyle}>
                {headerRow}
                <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 10px' }}>
                    Which service do you want a quote for?
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {(state.services || []).map((service, index) => (
                        <button
                            key={service.id}
                            type="button"
                            onClick={() => submitSelection(service.id)}
                            disabled={submitting}
                            style={{
                                textAlign: 'left',
                                padding: '12px',
                                borderRadius: '8px',
                                border: '1px solid #e5e7eb',
                                background: '#ffffff',
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
                                    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                                    background: `${primaryColor}14`, color: primaryColor,
                                    fontSize: '12px', fontWeight: 600,
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                }}
                            >
                                {index + 1}
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                                <span style={{ fontWeight: 500 }}>{service.name}</span>
                                {service.description && (
                                    <span style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>{service.description}</span>
                                )}
                            </span>
                        </button>
                    ))}
                </div>
                {errorLine}
            </div>
        );
    }

    // Step 2: choose requirements — walked ONE requirement at a time. No
    // pricing shown; the amount is computed server-side.
    if (state.status === 'choosing' && current) {
        const requirements = current.requirements || [];
        if (requirements.length === 0) {
            return (
                <div className="oyechats-quotation" style={cardStyle}>
                    {headerRow}
                    <p style={{ fontSize: '12px', color: '#6b7280', margin: '0 0 10px' }}>
                        No options here yet — tap Skip to talk to our team directly.
                    </p>
                </div>
            );
        }
        const idx = Math.min(reqIndex, requirements.length - 1);
        const req = requirements[idx];
        const isLast = idx >= requirements.length - 1;
        const goNext = (event) => {
            if (event) event.preventDefault();
            if (submitting) return;
            if (isLast) submitRequirements();
            else { setReqIndex(idx + 1); if (error) setError(''); }
        };
        const goBack = () => {
            if (submitting || idx === 0) return;
            setReqIndex(idx - 1);
            if (error) setError('');
        };
        const askQ = Math.max(0, Math.floor(Number(askQty[req.id]) || 0));
        const askUnit = req.unit_label || 'unit';
        const askUnitDisp = askQ === 1 ? askUnit : (/s$/i.test(askUnit) ? askUnit : `${askUnit}s`);
        const qtyStepper = (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: req.type === 'choice' ? '10px' : 0 }}>
                <input
                    type="number" min="0" max="100000" inputMode="numeric"
                    value={askQ}
                    onChange={(e) => setAskQuantity(req.id, e.target.value)}
                    disabled={submitting}
                    aria-label="Quantity"
                    style={{ ...inputStyle, width: '110px' }}
                />
                <span style={{ fontSize: '13px', color: '#6b7280' }}>{askUnitDisp}</span>
            </div>
        );
        return (
            <div className="oyechats-quotation" style={cardStyle}>
                {headerRow}
                <div style={{ height: '3px', background: '#f3f4f6', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
                    <div style={{ height: '100%', width: `${Math.round(((idx + 1) / requirements.length) * 100)}%`, background: primaryColor, transition: 'width 200ms ease' }} />
                </div>
                <form onSubmit={goNext}>
                    <label style={{ display: 'block', fontSize: '14px', color: '#111827', fontWeight: 500, marginBottom: '10px' }}>
                        {req.question || (req.type === 'choice' ? req.label : req.quantity_mode === 'ask' ? `How many ${askUnitDisp} do you need?` : 'Do you need this?')}
                    </label>
                    {req.type === 'choice' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {(req.options || []).map((opt) => {
                                const active = choicePicks[req.id] === opt.id;
                                return (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        onClick={() => pickOption(req.id, opt.id)}
                                        disabled={submitting}
                                        style={checkboxRowStyle(active)}
                                    >
                                        <span aria-hidden="true" style={radioBoxStyle(active)}>
                                            {active && <span style={radioDotStyle} />}
                                        </span>
                                        <span>{opt.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {req.quantity_mode === 'ask' ? (
                        qtyStepper
                    ) : req.type === 'item' ? (
                        <button
                            type="button"
                            onClick={() => toggleItem(req.id)}
                            disabled={submitting}
                            style={checkboxRowStyle(checkedItems.has(req.id))}
                        >
                            <span aria-hidden="true" style={checkboxBoxStyle(checkedItems.has(req.id))}>
                                {checkedItems.has(req.id) && <Check size={11} color="#ffffff" strokeWidth={3} />}
                            </span>
                            <span>{req.label}</span>
                        </button>
                    ) : null}
                    {errorLine}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        {idx > 0 && (
                            <button
                                type="button"
                                onClick={goBack}
                                disabled={submitting}
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 14px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#ffffff', color: '#374151', fontSize: '14px', cursor: submitting ? 'not-allowed' : 'pointer' }}
                            >
                                <ArrowLeft size={14} /> Previous
                            </button>
                        )}
                        <button type="submit" disabled={submitting} style={{ ...primaryButtonStyle, marginTop: 0, flex: 1 }}>
                            {submitting ? 'Sending...' : 'Continue'} <ArrowRight size={14} />
                        </button>
                    </div>
                </form>
            </div>
        );
    }

    // Step 3: email capture. No pricing is ever shown to the visitor here —
    // the quote itself (with pricing) is computed and stored server-side for
    // the admin's Lead detail view and the emailed PDF.
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
