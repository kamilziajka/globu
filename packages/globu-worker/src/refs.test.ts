import { describe, expect, it } from "vitest";
import { extractRefs } from "./refs.js";

const SHARDS = [
  { id: "product", repo: "git@github.com:acme/product.git" },
  { id: "backend", repo: "https://github.com/acme/backend" },
  { id: "local", repo: null }
];

describe("extractRefs", () => {
  it("takes shard-qualified refs and strips trailing punctuation", () => {
    const text = "Follow product/docs/decisions/012-pricing.md, then product/docs/api.md. See backend/src/x.ts).";
    expect(extractRefs(text, SHARDS).gating).toEqual([
      "product/docs/decisions/012-pricing.md",
      "product/docs/api.md",
      "backend/src/x.ts"
    ]);
  });

  it("does not read a path segment or an email as a shard ref", () => {
    const text = "In my-product/docs/x.md and /product/x.md and a.product/y.md nothing matches";
    expect(extractRefs(text, SHARDS).gating).toEqual([]);
  });

  it("maps code host file links to the shard that owns the repo", () => {
    const text = [
      "https://github.com/acme/product/blob/main/docs/decisions/012-pricing.md,",
      "https://github.com/acme/backend/-/blob/main/src/x.ts",
      "https://github.com/other/repo/blob/main/README.md",
      "https://github.com/acme/product/pull/12"
    ].join(" ");
    expect(extractRefs(text, SHARDS).gating).toEqual(["product/docs/decisions/012-pricing.md", "backend/src/x.ts"]);
  });

  it("keeps backticked bare paths as informational and drops the rest", () => {
    const text =
      "Change `src/render/snapshot.ts:272` and `package.json`; run `npm run verify`; see `e.g` and `/etc/hosts` and `v0.7.0` and `product/docs/api.md` and `src/render/snapshot.ts`.";
    expect(extractRefs(text, SHARDS)).toEqual({
      gating: ["product/docs/api.md"],
      informational: ["src/render/snapshot.ts", "package.json"]
    });
  });

  it("does not list a path twice when a bare path also appears qualified", () => {
    const refs = extractRefs("product/docs/api.md and `product/docs/api.md`", SHARDS);
    expect(refs).toEqual({ gating: ["product/docs/api.md"], informational: [] });
  });
});
