import assert from "node:assert/strict";
import * as bench from "../../src/ring8/swe-eval-bench.ts";

const format = Reflect.get(bench, "formatSchemaBudgetLine");
assert.equal(typeof format, "function", "Benchmark report must format the measured schema without a stale baseline");
assert.equal(format(1053), "- **Active Tool Schema:** `1053` `o200k_base` tokens");
assert.equal(format(1063), "- **Active Tool Schema:** `1063` `o200k_base` tokens");
console.log("Benchmark schema report reflects its measured value: PASS");
