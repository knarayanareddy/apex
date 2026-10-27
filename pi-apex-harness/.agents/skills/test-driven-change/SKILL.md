---
name: test-driven-change
description: A careful repository workflow for small, testable code changes with clear verification.
---
# Test-driven change

Use this as a checklist for a requested repository change. It is guidance, not permission to edit or run commands beyond the user's request and the active tool policy.

1. Inspect the relevant implementation, callers, tests, and project instructions before proposing edits.
2. If the change is architectural or safety-sensitive, write a short spec and acceptance criteria before implementation.
3. Identify the smallest observable behavior change and a focused regression test. Keep unrelated formatting and refactors out of scope.
4. Make changes only in the requested repository and preserve existing approvals, trust boundaries, and provider allowlists.
5. Run the most relevant tests first, then typecheck or broader tests when practical. Record exact commands and outcomes.
6. Review the final diff for accidental files, secrets, generated artifacts, stale docs, and tests that assert implementation details instead of behavior.
7. Report what changed, what passed, what did not run, and any remaining limitation. Never describe unrun tests as passing.
