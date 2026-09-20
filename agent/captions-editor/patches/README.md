# Narrow upstream accessibility patch

Pinned release: ehmo/gomoufox v0.1.29, commit `98be4f2731d5be8922e83a59191d48358fedddcd`.

`observed-inputs.patch` touches only:

- `internal/mcp/scripts/snapshot.js`: proper associated labels, file/checkbox roles, disabled and checked metadata. Hidden file inputs are observable only with existing upload permission.
- `internal/a11y/a11y.go`: preserves typed metadata through JSON and rejects stale metadata during reference resolution.
- `internal/mcp/gomoufox_session.go`: passes the existing upload permission into the fixed snapshot script and returns the metadata.

This extends the trusted adapter's fixed DOM observation. It exposes no arbitrary page-evaluation endpoint, selectors, cookies, requests, or fingerprint options. The Docker build runs upstream a11y and MCP tests, then application tests. The network-isolated fixture exercises the patched binary against an owned page with hidden file input and checkbox controls.

`observed-inputs-v2` additionally recognizes explicit ARIA switch roles before native button roles, preserves boolean checked state, and reports exact nearby text separately as `label_context` for otherwise unnamed toggles. Context is limited to 200 characters and a nearest ancestor with one toggle; it is not an invented accessible name. Ref matching includes that context and checked state.

`observed-inputs-v3` fixes an upstream resolver collision: the previous six-ancestor path limit could assign the same selector to repeated deep rows. The fixed path includes full ancestry; ID short-circuiting requires uniqueness. Existing revalidation still checks metadata before dispatch. A real browser fixture with three unnamed switches in eight nested wrappers verifies that only the intended middle switch changes; it fails against the previous binary.
