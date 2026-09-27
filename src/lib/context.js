/**
 * Who is making the current request.
 *
 * Carried in async local storage rather than threaded through every function,
 * so things far from the route — the activity log, most of all — can record
 * the organisation and the person behind a change without every caller having
 * to pass them along.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run `fn` with this request's user attached. */
export const runWithContext = (context, fn) => storage.run(context, fn);

export const currentContext = () => storage.getStore() || null;

/** The organisation whose data this request is allowed to touch. */
export const currentOrgId = () => currentContext()?.orgId ?? null;

export const currentUserId = () => currentContext()?.user?.id ?? null;
