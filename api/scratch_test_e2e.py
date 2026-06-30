import asyncio

import websockets

from app.db.session import get_session
from app.services.notification_service import create_notification


async def listen_ws(stop_event):
    ws_uri = "ws://localhost:8000/ws/notifications"
    subprotocol = "api-key.1f19ecd0d31d4543a75a54bd369f3d19"
    try:
        async with websockets.connect(ws_uri, subprotocols=[subprotocol]) as websocket:
            print("WS: Connected to notifications WebSocket!")
            hello = await websocket.recv()
            print("WS: Received hello:", hello)

            # Signal that we are connected
            stop_event.set()

            # Wait for the notification event
            while True:
                msg = await websocket.recv()
                print("WS: Received message:", msg)
                if "notification.created" in msg:
                    print("WS: SUCCESS! Real-time notification received!")
                    break
    except Exception as e:
        print("WS Error:", e)


def trigger_notification():
    print("DB: Triggering create_notification...")
    with get_session() as session:
        notif = create_notification(
            session,
            client_id=45,
            type_="handoff_request",
            title="E2E Test Handoff",
            body="Checking if WS broadcast is received.",
            link="/support?session=test_session",
            data={"session_id": "test_session"},
        )
        print("DB: Created notification ID:", notif["id"])


async def main():
    stop_event = asyncio.Event()
    # Start WS listener in background
    ws_task = asyncio.create_task(listen_ws(stop_event))

    # Wait until WS is connected
    await stop_event.wait()
    await asyncio.sleep(0.5)  # extra buffer

    # Trigger notification creation in a helper thread (since create_notification is sync)
    await asyncio.to_thread(trigger_notification)

    # Wait for the WS listener to finish or timeout after 5 seconds
    try:
        await asyncio.wait_for(ws_task, timeout=5.0)
    except TimeoutError:
        print("WS Timeout: Did not receive the broadcast within 5 seconds.")


if __name__ == "__main__":
    asyncio.run(main())
