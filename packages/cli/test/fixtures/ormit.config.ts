import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelBuilder } from '@ormit/core';
import { defineModel } from './sample-model.js';

/**
 * A real bare-specifier import resolved via node_modules — this is exactly
 * what breaks if the bundler's temp file isn't colocated with this file (see
 * ts-loader.ts). If this fixture loads without throwing ERR_MODULE_NOT_FOUND,
 * that mechanism is working.
 */
export const proof = new ModelBuilder();

/**
 * The standard `dirname(fileURLToPath(import.meta.url))` idiom for building
 * robust relative paths — this only stays correct if the transpiled file
 * ts-loader actually runs is colocated with the original, since it can only
 * ever report *its own* location, not the source file's.
 */
export const ownDirectory = dirname(fileURLToPath(import.meta.url));

export default {
  engine: () => ({ generator: {} as never, executor: {} as never }),
  model: defineModel,
  migrationsDir: './migrations',
};
