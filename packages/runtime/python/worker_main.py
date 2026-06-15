"""Legion worker launcher.

Drives the vendored hermes-agent programmatically (AIAgent from run_agent)
in non-interactive single-task mode and emits one JSON object per line on
stdout for every meaningful unit: model messages, tool calls, tool results,
agent status. The supervisor parses this stream into worker_events.

This file is Legion code — the vendored hermes-agent is never modified.
"""

import json
import os
import sys


def emit(event_type, **payload):
    line = json.dumps({"type": event_type, **payload}, ensure_ascii=False, default=str)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _extract_json(text):
    """Extract a single JSON object from a model's final message.

    Tolerates ```json fences and surrounding prose by taking the substring
    from the first '{' to the last '}'. Returns the substring only if it
    parses as JSON; otherwise returns the raw text (so the orchestrator's
    schema validation still rejects it as PLAN_INVALID, preserving behavior).
    """
    import json as _json
    import re as _re

    t = text.strip()
    fence = _re.search(r"```(?:json)?\s*(.*?)```", t, _re.DOTALL)
    if fence:
        t = fence.group(1).strip()
    i, j = t.find("{"), t.rfind("}")
    if i != -1 and j != -1 and j > i:
        candidate = t[i : j + 1]
        try:
            _json.loads(candidate)
            return candidate
        except Exception:
            return candidate  # invalid JSON → orchestrator records PLAN_INVALID
    return t


def clip(value, limit=4000):
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    return text[:limit]


def main():
    task = os.environ.get("LEGION_TASK")
    model = os.environ.get("LEGION_MODEL")
    base_url = os.environ.get("LEGION_BASE_URL", "https://openrouter.ai/api/v1")
    max_turns = int(os.environ.get("LEGION_MAX_TURNS", "12"))
    # M6d: which hermes toolset this worker gets. "terminal" (default) for
    # code/task workers; "web" for open-mission workers — an explicit
    # read-only allowlist (exactly web_search + web_extract; no shell, no
    # file tools, no send). Anything not in the toolset is unreachable.
    toolset = os.environ.get("LEGION_TOOLSET", "terminal")

    if not task:
        emit("ERROR", message="LEGION_TASK is not set")
        sys.exit(2)
    if not model:
        emit("ERROR", message="LEGION_MODEL is not set")
        sys.exit(2)
    if not os.environ.get("OPENROUTER_API_KEY"):
        emit("ERROR", message="OPENROUTER_API_KEY is not set")
        sys.exit(2)

    from run_agent import AIAgent  # resolved via PYTHONPATH → vendor/hermes-agent

    def on_tool_start(*args):
        call_id = args[0] if len(args) > 0 else None
        name = args[1] if len(args) > 1 else None
        tool_args = args[2] if len(args) > 2 else None
        emit("TOOL_CALL", toolCallId=str(call_id), tool=str(name), args=clip(tool_args))

    def on_tool_complete(*args):
        call_id = args[0] if len(args) > 0 else None
        name = args[1] if len(args) > 1 else None
        result = args[3] if len(args) > 3 else None
        emit("TOOL_RESULT", toolCallId=str(call_id), tool=str(name), result=clip(result))

    def on_interim(*args):
        text = args[0] if args else ""
        if text:
            emit("MODEL_MESSAGE", text=clip(text))

    def on_status(*args):
        kind = str(args[0]) if args else ""
        message = clip(args[1], 1000) if len(args) > 1 else ""
        emit("AGENT_STATUS", kind=kind, message=message)

    agent = AIAgent(
        base_url=base_url,
        model=model,
        max_iterations=max_turns,
        enabled_toolsets=[toolset],
        tool_start_callback=on_tool_start,
        tool_complete_callback=on_tool_complete,
        interim_assistant_callback=on_interim,
        status_callback=on_status,
    )
    # Keep stdout machine-readable: hermes' own status prints go quiet.
    try:
        agent.suppress_status_output = True
    except Exception:
        pass

    if toolset == "web":
        # M6d isolation proof (T75): report, from inside the worker process,
        # the environment it actually sees. Asserted by the test suite.
        emit(
            "AGENT_STATUS",
            kind="isolation",
            message=json.dumps(
                {"toolset": toolset, "envKeys": sorted(os.environ.keys())}
            ),
        )

    emit("AGENT_STATUS", kind="lifecycle", message=f"task started (model={model})")
    result = agent.run_conversation(task) or {}

    final = result.get("final_response") or ""
    if final:
        emit("MODEL_MESSAGE", text=clip(final, 8000), final=True)

    # M2-fix: seal a JSON deliverable from the final message. Models (notably
    # qwen3-coder) sometimes loop trying to WRITE plan.json/review.json via the
    # shell and never produce the file. When LEGION_SEAL_FILE is set and the
    # agent did NOT write it, capture the agent's final message as that file
    # (extracting the JSON object). The shell heredoc write stays the happy
    # path — we only seal when the file is missing, so a well-behaved write
    # wins and we never clobber it.
    seal_file = os.environ.get("LEGION_SEAL_FILE")
    if seal_file and final.strip() and not os.path.exists(seal_file):
        payload = _extract_json(final)
        if payload:
            with open(seal_file, "w") as f:
                f.write(payload)
            emit("AGENT_STATUS", kind="lifecycle", message=f"sealed {seal_file} from final message")

    if toolset == "web":
        # M6d (pin 4/5): the open agent has NO write tools by design — the
        # launcher (trusted Legion code) seals the agent's final response as
        # the deliverable. The only write this process performs is here, into
        # deliverables/ inside its own workdir.
        if final.strip():
            os.makedirs("deliverables", exist_ok=True)
            with open(os.path.join("deliverables", "report.md"), "w") as f:
                f.write(final)
            emit("AGENT_STATUS", kind="lifecycle", message="report sealed to deliverables/report.md")
    emit(
        "AGENT_STATUS",
        kind="lifecycle",
        message="task completed={} api_calls={}".format(
            bool(result.get("completed")), result.get("api_calls")
        ),
    )


if __name__ == "__main__":
    main()
