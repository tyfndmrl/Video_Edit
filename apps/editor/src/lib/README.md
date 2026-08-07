# src/lib

Shared pure helpers for the editor (geometry, easing, canvas utils) live here.

**Time helpers are NOT duplicated here.** All microsecond/frame/timecode math
(`usToFrame`, `frameToUs`, `formatTimecode`, rational fps helpers, the half-up
rounding contract) is owned by `@videoedit/timeline-schema` and must be imported
from that package:

```ts
import { usToFrame, frameToUs, formatTimecode } from '@videoedit/timeline-schema';
```

Rationale: the rounding rules are a cross-language contract shared with the C#
export compiler (design docs §1.1 and 05-chief-architect-review.md). A local
copy of `time.ts` would inevitably drift and break preview/export parity — do
not create one in this directory.
