# ADR 003: Index by full immutable advert

Status: accepted.

`Application a`, `Score a`, and `Memory a` name the exact advert value. Answers and experience are further indexed by the ordered lists of question and skill values. IDs and vector lengths alone would miss edits that preserve identifiers and counts.

Opaque approval constructors prevent evidence fabrication through the public API. Opaque advert/application/score constructors route construction through validation and scoring. Adverts freeze at publication, before any applications; phase 1 has no mutable advert editor or unsafe reindexing operation.

This guarantee operates inside the typed program. Persistence must retain complete immutable snapshots and validate reconstructed values. Pure values remain reusable, numeric totals can be extracted and compared, and intentional reconstruction is possible. No claim is made that arbitrary database writes or source changes are prevented by the compiler.
