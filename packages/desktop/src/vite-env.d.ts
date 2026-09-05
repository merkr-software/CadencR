/// <reference types="vite/client" />
// `@cadencr/terminal-core` is consumed as TypeScript source (its export points
// at `renderer/index.ts`, not a compiled `.d.ts`), so desktop type-checks the
// renderer's WebGPU code and needs the same ambient types.
/// <reference types="@webgpu/types" />
