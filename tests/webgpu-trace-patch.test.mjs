import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const patchPath = new URL('../patches/0005-ggml-webgpu-graph-progress-trace.patch', import.meta.url);
const patch = await readFile(patchPath, 'utf8');

test('WebGPU trace observes the existing zero-timeout poll without adding a wait', () => {
  const zeroTimeoutPolls = patch.match(/WaitAny\(1, &sub->submit_done, 0\)/g) ?? [];
  const blockingWaits = patch.match(/WaitAny\(1, &subs\[0\]\.submit_done, WEBGPU_WAIT_ANY_TIMEOUT_MS \* 1e6\)/g) ?? [];

  assert.equal(zeroTimeoutPolls.length, 1);
  assert.equal(blockingWaits.length, 1);
  assert.match(patch, /poll (?:begin|end).*subs/);
  assert.match(patch, /status=.*subs_before=.*subs_after=/);
});

test('WebGPU trace records node metadata and MUL_MAT path details', () => {
  assert.match(patch, /ggml_get_name\(/);
  assert.match(patch, /ggml_type_name\(/);
  assert.match(patch, /node=.*ne=\[/);
  assert.match(patch, /encode node=.*op=.*name=.*type=.*ne=/);
  assert.match(patch, /path=(?:vec|fast|legacy)/);
  assert.match(patch, /pipeline=.*wg=/);
});

test('WebGPU trace marks existing build lifecycle boundaries', () => {
  for (const marker of [
    'param_alloc begin',
    'bind_group begin',
    'encoder begin',
    'dispatch begin',
    'finish end',
  ]) {
    assert.match(patch, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
