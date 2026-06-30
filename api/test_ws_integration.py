import asyncio
import json

import httpx
import websockets


async def run_integration_test():
    # WebSocket URI and HTTP base
    ws_uri = "ws://localhost:8000/ws/notifications"
    http_url = "http://localhost:8000/operators/handoff"

    # Subprotocol using the client API key we verified
    subprotocol = "api-key.1f19ecd0d31d4543a75a54bd369f3d19"

    print("Connecting to notifications WebSocket...")
    async with websockets.connect(ws_uri, subprotocols=[subprotocol]) as websocket:
        print("Connected successfully!")

        # Wait for hello frame
        hello_frame = await websocket.recv()
        print("Received hello frame:", hello_frame)

        # Trigger handoff via HTTP POST
        print("Triggering handoff request via REST...")
        headers = {"X-API-Key": "1f19ecd0d31d4543a75a54bd369f3d19"}
        handoff_payload = {
            "session_id": "test_ws_session_123",
            "department_id": None,
            "reason": "I need help with billing integration test",
        }

        async with httpx.AsyncClient() as client:
            resp = await client.post(http_url, json=handoff_payload, headers=headers)
            print("REST Response:", resp.status_code, resp.json())

        # Wait for the broadcasted notification
        print("Waiting for real-time broadcasted notification...")
        try:
            broadcast = await asyncio.wait_for(websocket.recv(), timeout=5.0)
            print("SUCCESS! Received real-time broadcast:", broadcast)
            data = json.loads(broadcast)
            assert data["event"] == "notification.created"
            assert data["notification"]["type"] == "handoff_request"
            print("All assertions passed successfully!")
        except TimeoutError:
            print("FAILED: Did not receive real-time notification broadcast within 5 seconds.")


if __name__ == "__main__":
    asyncio.run(run_integration_test())
