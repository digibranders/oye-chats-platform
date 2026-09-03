/**
 * Merge server-restored live-chat history into the messages already held in
 * memory, without re-appending anything the visitor can already see.
 *
 * The previous rule was "append every restored row newer than the newest local
 * timestamp". That duplicated the visitor's own last messages on every
 * reconnect: a locally-sent message carries the CLIENT clock, the persisted row
 * carries the (later) SERVER clock, so the row always looked newer than
 * everything local and was appended again as a second bubble.
 *
 * The reliable key is the database id: the server hands it to us on
 * ``message_ack`` for the visitor's own messages and on ``message``/``file``
 * frames for the operator's, so anything already carrying that id is by
 * definition already rendered. The timestamp comparison is kept only as the
 * tiebreaker for rows that have no id on either side.
 */
export const mergeRestoredLiveMessages = (prev, restored) => {
    const incoming = Array.isArray(restored) ? restored : [];
    const existing = Array.isArray(prev) ? prev : [];
    if (incoming.length === 0) return existing;
    if (existing.length === 0) return incoming;

    const knownDbIds = new Set();
    const knownIds = new Set();
    let latestTs = '';
    for (const m of existing) {
        if (typeof m?.dbId === 'number') knownDbIds.add(m.dbId);
        if (m?.id) knownIds.add(m.id);
        const ts = m?.timestamp || '';
        if (ts > latestTs) latestTs = ts;
    }

    const toAppend = incoming.filter((m) => {
        if (typeof m?.dbId === 'number' && knownDbIds.has(m.dbId)) return false;
        if (m?.id && knownIds.has(m.id)) return false;
        return (m?.timestamp || '') > latestTs;
    });
    return toAppend.length > 0 ? [...existing, ...toAppend] : existing;
};

export default mergeRestoredLiveMessages;
