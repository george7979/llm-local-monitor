import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTags, findModel } from '../src/collectors/ollamaModels.js';

test('mapTags maps Ollama /api/tags fields and sorts by name', () => {
  const raw = {
    models: [
      { name: 'qwen3:32b', size: 20_000_000_000,
        details: { parameter_size: '32B', quantization_level: 'Q4_K_M' } },
      { name: 'gemma3:27b', size: 17_000_000_000,
        details: { parameter_size: '27B', quantization_level: 'Q4_0' } },
    ],
  };
  assert.deepEqual(mapTags(raw), {
    models: [
      { name: 'gemma3:27b', sizeBytes: 17_000_000_000, parameterSize: '27B', quantization: 'Q4_0' },
      { name: 'qwen3:32b',  sizeBytes: 20_000_000_000, parameterSize: '32B', quantization: 'Q4_K_M' },
    ],
  });
});

test('mapTags tolerates missing models array and missing details', () => {
  assert.deepEqual(mapTags({}), { models: [] });
  assert.deepEqual(mapTags({ models: [{ name: 'x' }] }), {
    models: [{ name: 'x', sizeBytes: 0, parameterSize: '', quantization: '' }],
  });
});

test('findModel matches exactly and rejects junk input', () => {
  const models = [{ name: 'qwen3:32b' }, { name: 'qwen3:32b-200k' }];
  assert.equal(findModel(models, 'qwen3:32b').name, 'qwen3:32b');
  assert.equal(findModel(models, 'qwen3'), null);
  assert.equal(findModel(models, ''), null);
  assert.equal(findModel(models, undefined), null);
  assert.equal(findModel(models, { name: 'qwen3:32b' }), null);
});
