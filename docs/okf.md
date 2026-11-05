---
type: "Explainer"
title: "OKF in Globu"
description: "Which parts of the Open Knowledge Format Globu reads, writes and checks, where it extends the spec and what that means for a base made with other tools."
---

# OKF in Globu

The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (OKF) is a specification from Google Cloud for knowledge that people and agents edit together: a directory of Markdown files with YAML frontmatter, versioned in git, with an `index.md` as the entry point and a `log.md` as the history. Globu bases are OKF bundles at version 0.2 of the [spec](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). This page says which parts of the spec Globu uses, so that you know what a base made with Globu looks like to other tools and what a base made with other tools looks like to Globu.

## The reserved files

| File | In the spec | In Globu |
|---|---|---|
| `index.md` | Marks the bundle root with `okf_version` and lists the content. | Written by `base setup` with `okf_version`, `name`, `description` and `knowledge_base_version`, plus the authoring guide between HTML comment markers. `name` and `description` feed the session index. |
| `log.md` | The history of the bundle. | Dated sections, newest first. `base log` adds entries and `update-knowledge` logs every edit it makes. |
| Every other `.md` | A concept doc with YAML frontmatter and a `type`. | The same. `type` is free text, such as `Decision`, `Runbook` or `API Endpoint`. |

## What validate checks

`globu base validate` is a structural check. It runs on demand on one base or on every base under a directory, and from the edit hook after each change Claude makes. It reports:

- a base directory without an `index.md`
- an `index.md` without `okf_version`
- a concept doc without a frontmatter block, or with a missing or empty `type`
- frontmatter that does not parse as YAML

It does not check prose, links between pages or any optional field. A base that passes is well formed, not necessarily correct.

## The optional families

Version 0.2 defines optional frontmatter families beyond the reserved files. Globu accepts all of them and acts on none yet.

| Family | Fields | In Globu today |
|---|---|---|
| Provenance | `sources`, a list with ids that footnotes cite | Passed through. Nothing reads or writes it. |
| Trust | `generated` and `verified`, each `{by, at}` with an actor such as `claude-code/x`, `human:<id>` or `process:<id>` | Passed through. Reading a doc's trust tier is planned. |
| Lifecycle | `status` of `draft`, `stable` or `deprecated`, and `stale_after` | Passed through. Surfacing stale docs is planned. |
| Attested Computations | Verified results attached to a doc | Out of scope. Aimed at data catalogs. |

Every timestamp in these families is an ISO 8601 datetime with an offset, such as `2026-11-05T08:00:00Z`. A bare date is not valid. This is what a doc that uses the trust and lifecycle fields looks like:

```yaml
---
type: "Research"
title: "Ideas from outside"
sources:
  - id: karpathy
    resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
    title: "LLM Wiki"
generated: { by: "claude-code/claude-opus-5-5", at: 2026-11-05T08:00:00Z }
verified: { by: "human:kazet", at: 2026-11-06T09:30:00+01:00 }
stale_after: 2027-05-01T00:00:00Z
---
```

## Where Globu extends the spec

- **Frontmatter in `index.md`.** Section 8 of the spec allows nothing in the root `index.md` frontmatter except `okf_version`. Globu also writes `name`, `description` and `knowledge_base_version` there, because the session index needs the first two and `base setup` needs the third to upgrade a base in place. Section 11 says a consumer never rejects a bundle for unknown frontmatter keys, so a strict OKF reader keeps them and carries on.
- **The authoring guide.** Globu keeps its authoring guide inside `index.md` between `knowledge-base:authoring-guide` HTML comments. That is ordinary Markdown and within the spec, but a tool that rewrites `index.md` has to keep the block for `base setup` to recognise it.

## Bases made elsewhere

Any OKF bundle works as a shard as it is: register the repo and Globu reads it. The spec says a consumer must tolerate broken links, and Globu does. Running `base setup` on such a bundle adds the authoring guide and the extra `index.md` keys and changes nothing else.
