/**
 * BASE-101-U1 spike P-1 fixtures, captured 2026-11-22 from Claude Code 2.1.330 in a scratch project
 * (one main-session turn that launched one general-purpose subagent, then a second turn).
 * Stripped: hook payload text values are "", lists and objects are emptied, paths are placeholders;
 * transcript lines keep only type, isSidechain, sessionId, uuid, timestamp and message id/model/role/usage.
 * No prompt or response text is present.
 */

export const PAYLOADS = {
  "stopTurn1": {
    "session_id": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "transcript_path": "<projects>/<project>/3b0529f1-247d-40ea-aee7-ee68d800eb4a.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "de1d435f-6e17-498f-8620-0cba2a13992c",
    "permission_mode": "default",
    "effort": {},
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "",
    "background_tasks": [],
    "session_crons": []
  },
  "stopTurn2": {
    "session_id": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "transcript_path": "<projects>/<project>/3b0529f1-247d-40ea-aee7-ee68d800eb4a.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "5169993c-9a0f-4150-ad3b-95659914f860",
    "permission_mode": "default",
    "effort": {},
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "",
    "background_tasks": [],
    "session_crons": []
  },
  "subagentStop": {
    "session_id": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "transcript_path": "<projects>/<project>/3b0529f1-247d-40ea-aee7-ee68d800eb4a.jsonl",
    "cwd": "<cwd>",
    "prompt_id": "de1d435f-6e17-498f-8620-0cba2a13992c",
    "permission_mode": "default",
    "agent_id": "af031591337d726df",
    "agent_type": "general-purpose",
    "effort": {},
    "hook_event_name": "SubagentStop",
    "stop_hook_active": false,
    "agent_transcript_path": "<projects>/<project>/3b0529f1-247d-40ea-aee7-ee68d800eb4a/subagents/agent-af031591337d726df.jsonl",
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
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "803f9953-2a08-4854-91d5-aadcde22fb7a",
    "timestamp": "2026-11-22T04:57:16.692Z",
    "message": {
      "role": "user"
    }
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "2860ece8-ab04-4f92-b892-85ab3d69d2b0",
    "timestamp": "2026-11-22T04:57:18.086Z",
    "message": {
      "id": "msg_011ChHNccQXYG3i2PU6BpSwH",
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
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "e4becd85-5c73-4b72-9860-834619a860ee",
    "timestamp": "2026-11-22T04:57:18.468Z",
    "message": {
      "id": "msg_011ChHNccQXYG3i2PU6BpSwH",
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
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "02514ca3-ce20-4886-b7e2-3108f963c611",
    "timestamp": "2026-11-22T04:57:19.983Z",
    "message": {
      "id": "msg_011ChHNcoFtjW1GgEoaa52VR",
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
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "3f0fb3d9-16c2-4f03-9f58-76781fd19db0",
    "timestamp": "2026-11-22T04:57:20.010Z"
  },
  {
    "type": "assistant",
    "isSidechain": false,
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "099a5a93-3229-41b9-8a23-1fe91ba2f1e6",
    "timestamp": "2026-11-22T04:57:29.492Z",
    "message": {
      "id": "msg_011ChHNdVkT3T5vUaQoG6TZK",
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
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "b8e1ed92-1a3b-47a6-8bd8-5e987d2645c8",
    "timestamp": "2026-11-22T04:57:18.484Z",
    "message": {
      "role": "user"
    }
  },
  {
    "type": "assistant",
    "isSidechain": true,
    "sessionId": "3b0529f1-247d-40ea-aee7-ee68d800eb4a",
    "uuid": "116aeac5-9fd5-4d27-856e-6da34ce8b824",
    "timestamp": "2026-11-22T04:57:19.276Z",
    "message": {
      "id": "msg_011ChHNck1RGjuD3znU7yeMi",
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
