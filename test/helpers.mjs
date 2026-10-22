import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const core = createRequire(import.meta.url)('../dist/core.js');
export const tfplan = createRequire(import.meta.url)('../dist/tfplan.js');
export const model = createRequire(import.meta.url)('../dist/model.js');

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixtureBytes = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
export const real = (name) => fixture(`real/${name}`);

/** A plan JSON document with sensible defaults, for small cases. */
export function planDoc(resource_changes = [], extra = {}) {
  return { format_version: '1.2', terraform_version: '1.9.0', resource_changes, ...extra };
}

/** One resource change entry. */
export function rc(address, actions, change = {}, extra = {}) {
  const i = address.indexOf('.');
  const [type, name] = address.replace(/^(module\.[^.]+\.)+/, '').replace(/^data\./, '').split('.');
  return {
    address,
    mode: address.startsWith('data.') || /\.data\./.test(address) ? 'data' : 'managed',
    type,
    name: (name ?? '').replace(/\[.*$/, ''),
    change: { actions, before: null, after: null, after_unknown: {}, before_sensitive: false, after_sensitive: false, ...change },
    ...extra,
    ...(i < 0 ? {} : {}),
  };
}

export const byAddress = (plan, address) => plan.resources.find((r) => r.address === address);
export const attr = (r, path) => core.attrAt(r.attrs, path);
