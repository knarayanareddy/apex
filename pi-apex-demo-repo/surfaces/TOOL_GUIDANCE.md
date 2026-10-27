# Tool Guidance (Externalized Surface)
- `read`, `write`, `edit`, `bash`: Core workspace primitives.
- `codemode`: Execute JavaScript in an isolated sandbox to discover (`searchTools(query)`, `describeTool(name)`) and compose MCP/auxiliary tools (`await tools.<name>(args)`) without bloating conversation context.
- `delegate_workers`: Spawn 1-level isolated `git worktree` workers for independent file sets, followed by an automated staging merge and blind diff review.
