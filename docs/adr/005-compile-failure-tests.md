# ADR 005: Expected compiler failures are executable tests

Status: accepted.

Keep valid and deliberately invalid source fixtures outside production modules. Stage them with current source, compile a positive control first, then require exit code 1 and targeted diagnostic fragments for each negative fixture. A manifest accounts for every negative file. Missing imports, undefined names, timeouts and holes do not count as proof of the invariant.

This makes the main question-set substitution demonstration part of normal verification and CI. Diagnostic fragments depend on the pinned compiler; a compiler upgrade may require reviewed fixture updates. Positive, runtime and generated invariant checks complement these tests rather than treating refusal alone as evidence that the application works.

Use bounded generated cases without an additional property-testing dependency for phase 1. Record explicitly that they provide no randomized search or shrinking.
