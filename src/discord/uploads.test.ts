/**
 * Attachment filenames are the only thing distinguishing two uploads, so the
 * rules are tested directly: keep the file's own name, keep its extension when
 * a suffix is needed, and never hand Discord two parts with the same name.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { uploadName, uploadNames } from "./uploads.ts";

test("an upload is named after the file, not its directory", () => {
	assert.equal(uploadName("/workspace/reports/sidee-breakdown.md"), "sidee-breakdown.md");
	assert.equal(uploadName("/workspace/notes"), "notes");
});

test("a path without a usable name falls back to one", () => {
	assert.equal(uploadName("/workspace/"), "file");
	assert.equal(uploadName(""), "file");
});

test("duplicate names gain a suffix before the extension", () => {
	assert.deepEqual(
		uploadNames(["/workspace/a/report.md", "/workspace/b/report.md", "/workspace/c/report.md"]),
		["report.md", "report-2.md", "report-3.md"],
	);
});

test("a name without an extension is suffixed at the end", () => {
	assert.deepEqual(uploadNames(["/workspace/a/notes", "/workspace/b/notes"]), ["notes", "notes-2"]);
});

test("a dotfile keeps its leading dot and gains the suffix after the name", () => {
	assert.deepEqual(uploadNames(["/workspace/.env", "/workspace/old/.env"]), [".env", ".env-2"]);
});
