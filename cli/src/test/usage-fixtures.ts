/**
 * BASE-101-U1 spike P-1 fixtures, captured 2026-11-22 from Claude Code 2.1.330 in a scratch project
 * (one main-session turn that launched one general-purpose subagent, then a second turn).
 * Stripped: hook payload text values are "", lists and objects are emptied, paths are placeholders;
 * transcript lines keep only type, isSidechain, sessionId, uuid, timestamp and message id/model/role/usage.
 * No prompt or response text is present. Ids are replaced by synthetic low-entropy values, keeping their roles
 * (same session, distinct messages, one id repeated over two lines).
 */

export const PAYLOADS = {
  "stopTurn1": {
    "session_id": "00000000-0000-4000-8000-000000000001",
    "transcript_path": "<projects>/<project>/00000000-0000-4000-8000-000000000001.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "00000000-0000-4000-8000-000000000002",
    "permission_mode": "default",
    "effort": {},
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "",
    "background_tasks": [],
    "session_crons": []
  },
  "stopTurn2": {
    "session_id": "00000000-0000-4000-8000-000000000001",
    "transcript_path": "<projects>/<project>/00000000-0000-4000-8000-000000000001.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "00000000-0000-4000-8000-000000000003",
    "permission_mode": "default",
    "effort": {},
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "",
    "background_tasks": [],
    "session_crons": []
  },
  "subagentStop": {
    "session_id": "00000000-0000-4000-8000-000000000001",
    "transcript_path": "<projects>/<project>/00000000-0000-4000-8000-000000000001.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "00000000-0000-4000-8000-000000000002",
    "permission_mode": "default",
    "agent_id": "agent0001",
    "agent_type": "general-purpose",
    "effort": {},
    "hook_event_name": "SubagentStop",
    "stop_hook_active": false,
    "agent_transcript_path": "<projects>/<project>/00000000-0000-4000-8000-000000000001/subagents/agent-agent0001.jsonl",
    "last_assistant_message": "",
    "background_tasks": [],
    "session_crons": []
  }
} as const;

/** Main-session transcript lines, in file order (turn 1: two assistant messages, the first on two lines; turn 2: one). */
export const MAIN_LINES: readonly unknown[] = [
  {
    "type": "user",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000004",
    "timestamp": "2026-11-22T04:57:16.692Z",
    "message": {
      "role": "user"
    }
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000005",
    "timestamp": "2026-11-22T04:57:18.086Z",
    "message": {
      "id": "msg_main_turn1_a",
      "model": "claude-haiku-5-5",
      "role": "assistant",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 19796,
        "cache_read_input_tokens": 11842,
        "output_tokens": 276
      }
    }
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000006",
    "timestamp": "2026-11-22T04:57:18.468Z",
    "message": {
      "id": "msg_main_turn1_a",
      "model": "claude-haiku-5-5",
      "role": "assistant",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 19796,
        "cache_read_input_tokens": 11842,
        "output_tokens": 276
      }
    }
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000007",
    "timestamp": "2026-11-22T04:57:19.983Z",
    "message": {
      "id": "msg_main_turn1_b",
      "model": "claude-haiku-5-5",
      "role": "assistant",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 533,
        "cache_read_input_tokens": 31638,
        "output_tokens": 3
      }
    }
  },
  {
    "type": "system",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000008",
    "timestamp": "2026-11-22T04:57:20.010Z"
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000009",
    "timestamp": "2026-11-22T04:57:29.492Z",
    "message": {
      "id": "msg_main_turn2_a",
      "model": "claude-haiku-5-5",
      "role": "assistant",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 39,
        "cache_read_input_tokens": 32171,
        "output_tokens": 3
      }
    }
  }
];

/** The subagent's own transcript (`<session>/subagents/agent-<agent_id>.jsonl`). */
export const AGENT_LINES: readonly unknown[] = [
  {
    "type": "user",
    "isSidechain": true,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000010",
    "timestamp": "2026-11-22T04:57:18.484Z",
    "message": {
      "role": "user"
    }
  },
  {
    "type": "assistant",
    "isSidechain": true,
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "uuid": "00000000-0000-4000-8000-000000000011",
    "timestamp": "2026-11-22T04:57:19.276Z",
    "message": {
      "id": "msg_agent_1",
      "model": "claude-haiku-5-5",
      "role": "assistant",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 20862,
        "cache_read_input_tokens": 0,
        "output_tokens": 4
      }
    }
  }
];
