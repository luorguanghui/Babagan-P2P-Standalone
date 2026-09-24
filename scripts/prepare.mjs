import { cp, mkdir, rm } from 'node:fs/promises';
await mkdir(new URL('../www/', import.meta.url), { recursive: true });
await cp(new URL('../client/', import.meta.url), new URL('../www/', import.meta.url), { recursive: true });
await rm(new URL('../www/upload-budget.mjs', import.meta.url), { force: true });
console.log('Standalone local assets prepared.');
