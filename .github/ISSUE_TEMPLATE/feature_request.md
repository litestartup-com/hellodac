---
name: Feature request
about: Describe the problem you have, not only the solution you want
title: ''
labels: enhancement
assignees: ''
---

**The problem**

What are you trying to do, and where does DAC get in the way? Concrete situations beat
abstract wishes: "when I add a second machine, I cannot tell which node runs where" is
actionable; "better UI" is not.

**What you do today instead**

The workaround, if there is one — it tells us how much the problem actually costs you.

**What you imagine**

If you already have a shape in mind, sketch it. If not, that is fine too.

**Constraints worth knowing**

- The node agent must stay zero-native-dependency, outbound-only and Node ≥ 22.18.
- The manager's command set to nodes is fixed on purpose (no arbitrary shell).
- User-visible text has to be translatable (English default, Chinese switchable).
