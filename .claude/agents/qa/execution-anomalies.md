# QA reference: execution anomalies

Part of `.claude/agents/qa.md`. It binds exactly as that file does. Read it when a part of the "after" snapshot cannot be recorded or compared, or when a check command did not end as "ran and passed".

## The "after" snapshot

**When the "after" snapshot cannot be taken or compared.** A git command of the "after" snapshot fails, or a part of it cannot be read. What follows depends on which part it is and on whether the run was already halting:

- **The part not compared is the ticket's task artifacts** — the hash of `plan.md`, `status.json`, `review-report.md` or `qa-report.md` cannot be taken or compared: halt, even at the end of an otherwise complete round. This is the same criterion as the halt for a detected change to those artifacts: you would be writing your report and your `status.json` fields on top of files that the executed code may have changed, and you cannot rule that out. No round is written. The halt message names the part, the command and its error, never says "no difference found" for the task artifacts, and reports the other parts as usual — compared, or not compared.
- **Any other part, at the end of an otherwise complete round** — the `git status` output, the hashes of changed and untracked files, or the commits and refs; every "to run" command was run, the task artifacts were compared and no halt applies: this is not a halt. The round is written, and the verdict is `fail` (Step 6), with the one-line reason that the snapshot comparison could not be completed and which parts could not be compared, with the command and its error. The report's snapshot result (Step 7) names those parts.
- **Any part, during a halt that is happening for another reason** — the environment abort, the doubt case, the task-artifact change, or any other halt after a check command has started: the halt stays a halt, and no round is written. The halt message names those parts (Step 1, second form of the closing lines).

In all three cases:

- name each part that could not be compared — the `git status` output, the hashes of changed and untracked files (naming the files concerned), the hashes of the ticket's task artifacts, or the commits and refs (naming the ref concerned) — with the command that failed and its error;
- never say "no difference found" for such a part, and never say it for the comparison as a whole while any part is not compared;
- report the parts that were compared as usual: their differences, or that none was found in them. A difference found in a compared part keeps its own effect — a changed task artifact is still a halt, and a changed file or a moved commit or ref is still its own reason for `fail`.

You do not run a command outside "Commands", repeat a check command, or repair anything to make the comparison possible.

## Environment abort

**Environment abort — a halt, not one of the three states.** A command that aborts before executing any test or check because of the environment — a missing module, tool or dependency, or an unsupported runtime version — is not "ran and failed". Decide this from the command's output, never by guesswork. Both conditions must hold:

1. the output shows that no test or check was executed — no test, lint or type result was reported for any file;
2. the error is about the runtime or a missing module or tool — for example `Cannot find package`, `command not found`, an engine or version error.

When both hold, halt, following "Halting after a check command has started" above: run no further check command, take the "after" snapshot and compare it — the aborting command and the commands before it have already executed, and the abort was decided from output the code under test produced. Then write nothing, name the command, its working directory and the error, list the commands already run in this round, give the result of the comparison, and say that the environment must be prepared before invoking again. No round is written, so the same completion can be verified once the environment is ready, without a same-completion request.

When only one of the two holds, or you are in doubt between an environment abort and a failure of the code under test, halt in the same way — the "after" snapshot and its comparison included — and say which of the two you could not tell. Never record a pass, and never record "no applicable check", for such a command.
