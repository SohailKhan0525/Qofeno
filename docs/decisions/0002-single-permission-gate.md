# ADR 0002: One gate for privileged operations

Status: accepted

Context: model output is untrusted; scattered checks invite bypasses.

Decision: every tool invocation flows through ToolRegistry.invoke (schema → permissions → policy → confirmation → bounds → audit). No other code path may execute privileged operations.

Consequences: simple auditing story; UX cost of explicit consent prompts is accepted deliberately.
