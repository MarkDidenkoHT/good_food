import { db } from './db.js';

/* The two permissions that are about getting in rather than about ordering,
   both off unless an operator has said otherwise.

   allow_owner_reset      — a company owner may reissue their own code, which
                            is the kill switch for everyone else in it.
   allow_multi_company_join — a user who already belongs somewhere may type
                            another company's code and be added to it too.
                            Off, memberships past the first are the panel's to
                            hand out; a code that leaked between two customers
                            then adds nobody to anything.

   Read on every use rather than cached: withdrawing a permission has to take
   effect without waiting for anybody to reload anything. */

export const AUTH_DEFAULTS = {
  allow_owner_reset: false,
  allow_multi_company_join: false
};

export async function authSettings() {
  const { data } = await db
    .from('app_settings').select('value').eq('key', 'auth').maybeSingle();
  return { ...AUTH_DEFAULTS, ...(data?.value || {}) };
}
