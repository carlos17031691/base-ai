# Post-lock decisions: BASE-140-A

## D1
- Decided: 2026-11-24T20:52:43Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T20:41:39Z, 2026-11-24T20:44:33Z
- Decision: The implementer's claim and completion entries carried timestamps that were not taken from the clock (2026-11-24T21:00:00Z and 2026-11-24T21:10:00Z, later than commit bc65321 at 2026-11-24T20:44:50Z and than the reviewer's run at 20:50:07Z, which halted on it without writing). The human chose to replace them with the real times from the implementer's subagent transcript: the claim's status.json write at 2026-11-24T20:41:39Z and the completion's at 2026-11-24T20:44:33Z. The coordinator applied the replacement; no other field of either entry changed.
- Affects: status.json 2026-11-24T20:41:39Z, status.json 2026-11-24T20:44:33Z

## D2
- Decided: 2026-11-24T20:52:00Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T20:53:24Z
- Decision: Send-back to the implementer before any review round was recorded. The reviewer's round 1 run halted on the timestamps (D1) without writing, and found that AC8 was not met: planner.md was 6013 bytes against 4 × 1500 = 6000. The human chose to send the task back so the implementer could cut at least 13 bytes from the D4 sentence, instead of recording a round 1 changes_requested only for that. The planner budget in .ai/config.yaml stays at 1500, as H2 says.
- Affects: .claude/agents/planner.md, AC8
