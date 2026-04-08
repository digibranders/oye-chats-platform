import json
import logging

import litellm
from pydantic import BaseModel, Field

from app.config import LLM_FALLBACKS, LLM_MODEL
from app.db.models import ChatSession
from app.db.repository import add_chat_message, ensure_chat_session, get_chat_history, update_session_bant
from app.db.session import get_session
from app.services.llm_service import generate_response, generate_response_stream

logger = logging.getLogger(__name__)


class BANTState(BaseModel):
    need: str | None = Field(None, description="The user's core business need or problem they are trying to solve.")
    timeline: str | None = Field(None, description="When the user plans to implement a solution.")
    authority: str | None = Field(
        None, description="Who else is involved in the decision-making process/evaluating the solution."
    )
    budget: str | None = Field(None, description="The budget range allocated for this solution.")


class SDRResponse(BaseModel):
    updated_bant: BANTState = Field(..., description="The updated BANT state based on the latest user message.")
    chat_response: str = Field(
        ...,
        description="The empathetic and consultative response to the user, including exactly ONE probe if any BANT field is missing.",
    )


SDR_BASE_PROMPT = """
You are a sales qualification assistant. Uncover BANT (Budget, Authority, Need, Timeline) through natural conversation.

RULES:
1. Update BANT fields from user messages. Carry forward existing values unless explicitly changed.
2. Ask ONE question per response for ONE missing field. Acknowledge before probing. Never sound like a survey.
3. Frame authority as team involvement, budget as tiers/ranges. If the user is evasive, don't press — provide value and pivot.
4. When all fields are populated, propose next steps (demo, call). If user goes off-topic, answer briefly then steer back.

CURRENT SESSION STATE:
- Need: {need}
- Timeline: {timeline}
- Authority: {authority}
- Budget: {budget}
"""

SDR_STREAM_PROMPT = (
    SDR_BASE_PROMPT
    + "\n\nIMPORTANT: Respond with natural, conversational plain text ONLY. DO NOT return any JSON, structured data, or code markers."
)
SDR_JSON_PROMPT = (
    SDR_BASE_PROMPT + "\n\nReturn your response in a structured JSON format matching the SDRResponse schema."
)


async def generate_sdr_stream(client_obj, question: str, session_id: str, bot_id: int = None):
    """
    Industry-level SDR qualification stream.
    Supports bot_id for multi-bot architecture.
    LiteLLM auto-instruments with Langfuse via callbacks.
    """
    try:
        cid = (
            getattr(client_obj, "client_id", None)
            if hasattr(client_obj, "bot_key")
            else getattr(client_obj, "id", None)
        )
        bid = bot_id or (getattr(client_obj, "id", None) if hasattr(client_obj, "bot_key") else None)

        with get_session() as session:
            # 1. Fetch Session and BANT state
            ensure_chat_session(session, session_id, client_id=cid, bot_id=bid)
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            if not chat_session:
                yield 'METADATA:{"error": "Session not found"}\n'
                return

            # Current BANT State
            current_bant = {
                "need": chat_session.bant_need,
                "timeline": chat_session.bant_timeline,
                "authority": chat_session.bant_authority,
                "budget": chat_session.bant_budget,
            }

            # 2. Fetch History
            history = get_chat_history(session, session_id, client_id=cid, limit=6, bot_id=bid)
            history_str = "\n".join([f"{m.role.upper()}: {m.content}" for m in history])

            # 3. Add User Message to History
            add_chat_message(session, session_id, client_id=cid, role="user", content=question, bot_id=bid)
            session.commit()

            # 4. Construct Prompt (STREAMING USES PLAIN TEXT PROMPT)
            prompt = SDR_STREAM_PROMPT.format(
                need=current_bant["need"] or "null",
                timeline=current_bant["timeline"] or "null",
                authority=current_bant["authority"] or "null",
                budget=current_bant["budget"] or "null",
            )

            yield f'METADATA:{{"session_id": "{session_id}"}}\n'

            full_answer = ""

            # Stream response (LiteLLM auto-traces via callback)
            for chunk in generate_response_stream(
                f"{prompt}\n\nHISTORY:\n{history_str}\nUSER: {question}\n\nRESPONSE:",
                metadata={"generation_name": "sdr-stream-generation"},
            ):
                full_answer += chunk
                yield chunk

            # 6. Post-processing: Extract BANT and save Bot Message
            bot_msg = add_chat_message(session, session_id, client_id=cid, role="bot", content=full_answer, bot_id=bid)
            session.commit()

            # 7. Background BANT update (LiteLLM auto-traces via callback)
            try:
                extraction_prompt = f'Given this conversation history:\n{history_str}\n\nAnd user\'s last message: \'{question}\'\n\nCurrent BANT: {current_bant}\n\nProvide the updated BANT fields in valid JSON matching this schema: {{"need": string, "timeline": string, "authority": string, "budget": string}}'

                resp_text = generate_response(
                    extraction_prompt,
                    metadata={"generation_name": "sdr-bant-extraction"},
                )
                try:
                    clean_json = resp_text.strip()
                    if clean_json.startswith("```json"):
                        clean_json = clean_json.split("```json")[-1].split("```")[0].strip()

                    bant_data = json.loads(clean_json)
                    update_session_bant(
                        session,
                        session_id,
                        client_id=cid,
                        bant_data={
                            "bant_need": bant_data.get("need"),
                            "bant_timeline": bant_data.get("timeline"),
                            "bant_authority": bant_data.get("authority"),
                            "bant_budget": bant_data.get("budget"),
                        },
                        bot_id=bid,
                    )
                    session.commit()
                except (json.JSONDecodeError, ValueError) as e:
                    logger.warning(f"SDR BANT JSON parsing failed: {e}")
            except Exception as e:
                logger.warning(f"SDR BANT extraction call failed: {e}")

            yield f'\nFINAL_METADATA:{{"message_id": {bot_msg.id}}}\n'

    except Exception as e:
        logger.error(f"SDR Streaming Error: {e}")
        yield f"Error: {str(e)}"


def run_sdr_qualification(client_obj, question: str, session_id: str, bot_id: int = None):
    """
    Industry-level SDR qualification flow with structured JSON output.
    Supports bot_id for multi-bot architecture.
    LiteLLM auto-instruments with Langfuse via callbacks.
    """
    try:
        cid = (
            getattr(client_obj, "client_id", None)
            if hasattr(client_obj, "bot_key")
            else getattr(client_obj, "id", None)
        )
        bid = bot_id or (getattr(client_obj, "id", None) if hasattr(client_obj, "bot_key") else None)

        with get_session() as session:
            # 1. Fetch Session and BANT state
            ensure_chat_session(session, session_id, client_id=cid, bot_id=bid)
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            if not chat_session:
                logger.error(f"Session {session_id} not found for SDR flow.")
                return {"error": "Session not found"}

            # Current BANT State
            current_bant = {
                "need": chat_session.bant_need,
                "timeline": chat_session.bant_timeline,
                "authority": chat_session.bant_authority,
                "budget": chat_session.bant_budget,
            }

            # 2. Fetch History
            history = get_chat_history(session, session_id, client_id=cid, limit=10, bot_id=bid)
            history_str = "\n".join([f"{m.role.upper()}: {m.content}" for m in history])

            # 3. Add User Message to History
            add_chat_message(session, session_id, client_id=cid, role="user", content=question, bot_id=bid)
            session.commit()

            # 4. Construct Prompt
            prompt = SDR_JSON_PROMPT.format(
                need=current_bant["need"] or "null",
                timeline=current_bant["timeline"] or "null",
                authority=current_bant["authority"] or "null",
                budget=current_bant["budget"] or "null",
            )

            # 5. Call LLM with Structured Output via LiteLLM
            response = litellm.completion(
                model=LLM_MODEL,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": f"Conversation History:\n{history_str}\nUSER: {question}"},
                ],
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "SDRResponse",
                        "strict": True,
                        "schema": SDRResponse.model_json_schema(),
                    },
                },
                metadata={"generation_name": "sdr-qualification"},
                fallbacks=LLM_FALLBACKS,
            )

            response_text = response.choices[0].message.content
            if not response_text:
                raise ValueError("Empty response from LLM")

            # 6. Parse and Update
            data = SDRResponse.model_validate_json(response_text)

            # Save updated BANT to DB
            bant_updates = {
                "bant_need": data.updated_bant.need,
                "bant_timeline": data.updated_bant.timeline,
                "bant_authority": data.updated_bant.authority,
                "bant_budget": data.updated_bant.budget,
            }
            update_session_bant(session, session_id, client_id=cid, bant_data=bant_updates, bot_id=bid)

            # Save Bot Response
            bot_msg = add_chat_message(
                session, session_id, client_id=cid, role="bot", content=data.chat_response, bot_id=bid
            )
            session.commit()

            return {
                "session_id": session_id,
                "answer": data.chat_response,
                "message_id": bot_msg.id,
                "bant_state": data.updated_bant.model_dump(),
            }

    except Exception as e:
        logger.error(f"SDR Qualification Error: {e}")
        return {"error": "Failed to process qualification", "detail": str(e)}
