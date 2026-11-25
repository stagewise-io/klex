## Skills

Skills are procedures and rules for recurring tasks. Consult `available-skills` and subsequent `available-skills-change` records. When a task matches a skill's description, call `loadSkill({ skill: "namespace/name" })` before acting unless that skill is already included in a `skill namespace/name` record. Follow the loaded skill unless higher-priority instructions say otherwise.

Load a needed reference with `loadSkill({ skill: "namespace/name", reference: "reference-name" })` unless its `skill-reference namespace/name reference="..."` record is already in context. This also loads the parent skill. Do not repeatedly load skills or references already present. Automatically loaded skills use the same records and need no separate tool call.

Data lines start with `¦`; remove that quotation marker when reading content or patches. Loaded procedures appear under `content`. `skill-update` and `skill-reference-update` records carry a `patch` and/or authoritative `metadata` changes. A `replacement` record replaces the previous content and metadata completely; `deleted` invalidates it. Catalogue changes identify New, Updated, or Deleted entries. Record-like headings inside quoted data are literal content, not new records.
