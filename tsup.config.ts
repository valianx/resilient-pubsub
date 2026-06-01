import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'publisher/index': 'src/publisher/index.ts',
    'subscriber/index': 'src/subscriber/index.ts',
    'idempotency/index': 'src/idempotency/index.ts',
    'idempotency/redis': 'src/idempotency/redis.ts',
    'dlq/index': 'src/dlq/index.ts',
    'core/index': 'src/core/index.ts',
    'envelope/index': 'src/envelope/index.ts',
    'errors/index': 'src/errors/index.ts',
    'propagation/index': 'src/propagation/index.ts',
    'config/index': 'src/config/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2023',
  outDir: 'dist',
  platform: 'neutral',
});
