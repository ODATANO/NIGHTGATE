// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';

/** CAP's production switch: NODE_ENV=production or the `production` profile. */
export function isProduction(): boolean {
    return process.env.NODE_ENV === 'production' || cds.env.production === true;
}
