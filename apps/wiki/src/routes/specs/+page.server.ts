import type { PageServerLoad } from './$types';
import { localAccess, pageData } from '../api/specs/store.server';
export const load: PageServerLoad = (event) => pageData(localAccess(event));
