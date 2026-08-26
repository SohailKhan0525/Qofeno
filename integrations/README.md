# Internal GitHub protection infrastructure

Per open2.md this is NOT a user-facing product. It protects the one repository:
webhook-verified automation for PR/workflow triage, secret-exposure detection
and release-artifact verification. Implementation: `@agent-qofeno/github-bot`
(kept out of user docs; deployed by maintainers only).
