# TODOs

## P2: Verify Zcal postMessage event format with real account
**What:** Test MeetingBooking.jsx Zcal postMessage handler with a real Zcal booking to capture the actual event format.
**Why:** Zcal's postMessage API is undocumented. The current handler checks 4 speculative patterns (`zcal:booking_confirmed`, `zcal.booking_confirmed`, `booking.confirmed`, `booked: true`). If none match, the booking modal stays open after the visitor completes booking — they have to manually dismiss it.
**Fix:** Create a test Zcal account, embed the iframe, complete a booking, inspect the postMessage events in devtools, update the handler.
**Effort:** S (human: ~1hr / CC: ~15min)
**Depends on:** Having a Zcal account to test with.
**File:** `widget/src/components/MeetingBooking.jsx:44-85`
