# QA reference: base choice

Part of `.claude/agents/qa.md`. It binds exactly as that file does. These four rules continue item 2, "Base", of Step 2, when `development` and `origin/development` point to different commits.

   - **The invocation names no base.** Halt. The halt message lists both refs, each with the full commit it points to now, and gives both ways out: invoke again naming one of the two refs with its commit as listed, or instead update the refs so that local `development` and `origin/development` point to the same commit and invoke again.
   - **The invocation names a base.** Accept it only if both hold: the ref it names is one of those two (`development` or `origin/development`), and the commit it gives for that ref — as an earlier halt message listed it — is the commit the ref points to now (a prefix of at least 7 characters of the full hash counts as the same commit). If it names any other ref, gives no commit, or the commit has moved, halt again with the current values of both refs; never proceed on a ref that is not where the invocation said it was.
   - **Record an accepted choice as given, not as a claim about who made it:** "`development` (`<sha>`) and `origin/development` (`<sha>`) differed; the invocation chose `<ref>` (`<sha>`)". Never write that the human chose the base.
   - The choice holds for this run only. A base recorded in an earlier round is data: if the two refs still differ in a later run, the invocation of that run must name the base again.
