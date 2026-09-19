# ADR 002: Small pure core with explicit application boundary

Status: accepted.

Keep domain types/transitions/scoring independent of effects. Application modules orchestrate current-state workflow and application intake through first-class record ports. Memory, CV lookup and wire encoding are adapters. A CLI supplies a useful executable composition root.

Implement the papers’ small container algebra explicitly: prompt-dependent replies, forward/backward handlers, direct-answer agents and the four combinators. Compose the five-link spine with sequence and sum. Keep the algebra pure and separate from stateful application services; a typed container is not a deployment unit.

No HTTP, UI, SQL, LLM SDK or deployment API enters the core. A lint check enforces dependency direction and forbids IO there. Authentication and durable persistence must be added at the application boundary before exposing a real recruitment service.
