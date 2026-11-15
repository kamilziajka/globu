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

`globu base validate` is a structural check. It runs on demand on one base or on every base under a directory, and from the edit hook after each change Claude makes. It reports these errors, which fail the base:

- a base directory without an `index.md`
- an `index.md` without `okf_version`
- a concept doc without a frontmatter block, or with a missing or empty `type`
- frontmatter that does not parse as YAML

And these warnings about the optional families below, which never fail it. Each names the field, such as `verified[1].by`. A doc that uses none of the families gets none.

- `sources` that is not a list, an entry that is not a mapping or has no `resource`, an `id` that is not a string and a footnote label in the body (outside code) that matches no `sources[].id`
- `generated` that is not a mapping or has no `by`
- `verified` that is neither a mapping nor a list of mappings, or an entry without `by` or `at`
- a `by` in `generated` or `verified` that is not an actor: `<producer>/<version>`, `human:<id>` or `process:<id>`
- `status` other than `draft`, `stable` or `deprecated`
- a timestamp that is not an ISO 8601 datetime with an offset: `generated.at`, `verified.at`, `stale_after`, `last_modified` and the `from` and `to` of a `usage_window`

It does not check prose or links between pages. A base that passes is well formed, not necessarily correct. The field checks live in `packages/knowledge-base/src/fields.ts` as plain functions over parsed frontmatter, so other commands can reuse them.

`globu base lint` is the content check beside it: links that do not resolve, docs nothing links to and index entries that drifted from the linked doc's `description`, which §8 says an entry should carry. Its findings are warnings and never fail it, as §6 asks of consumers. See [knowledge bases](./knowledge-base.md#lint).

## The optional families

Version 0.2 defines optional frontmatter families beyond the reserved files. Globu checks their shape, writes the trust fields and reads the lifecycle fields.

| Family | Fields | In Globu |
|---|---|---|
| Provenance | `sources`, a list with ids that footnotes cite | Checked by `validate`. Nothing writes it. |
| Trust | `generated` and `verified`, each `{by, at}` with an actor such as `claude-code/x`, `human:<id>` or `process:<id>` | Checked by `validate`. `base stamp` writes them and `update-knowledge` calls it. No trust tier is computed: the spec stores signals, not scores. |
| Lifecycle | `status` of `draft`, `stable` or `deprecated`, and `stale_after` | Checked by `validate`. `base stale` lists the docs past `stale_after` or `deprecated`, and `doctor` and the session index count them per shard. |
| Attested Computations | Verified results attached to a doc | Out of scope. Aimed at data catalogs. |

### Stamping trust

`globu base stamp <files...>` sets `generated: { by: "globu/<version>", at: <now> }` on each concept doc, replacing an earlier `generated`. `globu base stamp --verified <files...>` appends `{ by: "human:<id>", at: <now> }` to `verified` instead and leaves `generated` alone; a bare mapping becomes a list with the old entry first. `<id>` is git `user.name` in the doc's repo. When that is unset it falls back to the login name of the account running the command, and the command fails only when neither is known. Times are UTC to the second. Only the stamped key changes: the rest of the frontmatter keeps its quoting, comments and order, and the body is untouched. When one of the files cannot be stamped, none is written.

The `update-knowledge` skill stamps `generated` on each doc it creates or changes in substance, and adds a verification only when the user confirms a doc in the session. A doc with a `human:` entry in `verified` reads as human-reviewed to a consumer that derives OKF's trust tiers.

### Stale docs

A doc is stale when the current time is at or past its `stale_after`, and it counts here as well when its `status` is `deprecated`. A `stale_after` that does not parse is a `validate` warning and never makes a doc stale. `globu base stale [path]` lists them for every base under a directory, with the reason, and exits 0 either way. `globu doctor` and the session index give one line per shard with the count and that command, never the list, so the index stays short.

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

Any OKF bundle works as a shard as it is: register the repo and Globu reads it. The spec says a consumer must tolerate broken links, and Globu does: `base lint` reports them as warnings and nothing else in Globu reads them. Running `base setup` on such a bundle adds the authoring guide and the extra `index.md` keys and changes nothing else.
